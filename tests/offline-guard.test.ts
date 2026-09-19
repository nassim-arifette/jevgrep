import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import { test } from 'node:test';
import { offlinePreloadUrl, sourceEntry, runCli } from './helpers/cli-runner.ts';
import type { CliIo } from '../src/cli.ts';

/**
 * Offline guard for JG-001: the ordinary test suite must run without a Jev key and
 * without any provider call.
 *
 * In-process half: fetch, DNS lookup and every TCP connection attempt (which is also the
 * transport of node:http/https) are replaced by throwers, the arming of each one is
 * verified, and then every CLI path is exercised.
 * Child-process half: the same guard is preloaded into the spawned entry point through
 * tests/helpers/offline-preload.ts, so `node src/cli.ts …` is covered too.
 */
const attempts: string[] = [];

function blockedCall(label: string): () => never {
  return (): never => {
    attempts.push(label);
    throw new Error(`offline guard blocked a ${label} call`);
  };
}

type Restore = () => void;

function patch(target: object, key: string, replacement: unknown): Restore {
  const original: unknown = Reflect.get(target, key);
  const armed = Reflect.set(target, key, replacement);
  assert.equal(armed, true, `the offline guard could not arm ${key}`);
  return (): void => {
    Reflect.set(target, key, original);
  };
}

const nodeRequire = createRequire(import.meta.url);

test('every guarded network entry point is really armed', () => {
  const transport = nodeRequire('node:net') as typeof net;
  const httpModule = nodeRequire('node:http') as typeof http;
  const httpsModule = nodeRequire('node:https') as typeof https;
  const dnsModule = nodeRequire('node:dns') as typeof dns;

  const restores: Restore[] = [
    patch(globalThis, 'fetch', blockedCall('fetch')),
    patch(transport, 'connect', blockedCall('net.connect')),
    patch(transport, 'createConnection', blockedCall('net.createConnection')),
    patch(transport.Socket.prototype as unknown as object, 'connect', blockedCall('net.Socket#connect')),
    patch(httpModule, 'request', blockedCall('http.request')),
    patch(httpModule, 'get', blockedCall('http.get')),
    patch(httpsModule, 'request', blockedCall('https.request')),
    patch(httpsModule, 'get', blockedCall('https.get')),
    patch(dnsModule, 'lookup', blockedCall('dns.lookup')),
    patch(dnsModule.promises as unknown as object, 'lookup', blockedCall('dns.promises.lookup')),
  ];

  const probes: readonly (readonly [string, () => unknown])[] = [
    ['fetch', (): unknown => fetch('https://example.invalid/')],
    ['net.connect', (): unknown => transport.connect(80, 'example.invalid')],
    ['net.createConnection', (): unknown => transport.createConnection(80, 'example.invalid')],
    ['net.Socket#connect', (): unknown => new transport.Socket().connect(80, '127.0.0.1')],
    ['http.request', (): unknown => httpModule.request({ host: 'example.invalid', port: 80 })],
    ['http.get', (): unknown => httpModule.get({ host: 'example.invalid', port: 80 })],
    ['https.request', (): unknown => httpsModule.request({ host: 'example.invalid', port: 443 })],
    ['https.get', (): unknown => httpsModule.get({ host: 'example.invalid', port: 443 })],
    ['dns.lookup', (): unknown => dnsModule.lookup('example.invalid', () => undefined)],
    ['dns.promises.lookup', (): unknown => dnsModule.promises.lookup('example.invalid')],
  ];

  try {
    for (const [label, probe] of probes) {
      let thrown: unknown;
      try {
        probe();
      } catch (error) {
        thrown = error;
      }
      if (thrown === undefined) {
        assert.fail(`the offline guard is not armed for ${label}`);
      }
      assert.match(
        String(thrown),
        new RegExp(`offline guard blocked a ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} call`),
        `unexpected failure for ${label}`,
      );
    }
    assert.deepEqual([...attempts].sort(), probes.map(([label]) => label).sort());
  } finally {
    for (const restore of restores.reverse()) {
      restore();
    }
  }
});

test('CLI paths never touch the network', async () => {
  const transport = nodeRequire('node:net') as typeof net;
  const httpModule = nodeRequire('node:http') as typeof http;
  const httpsModule = nodeRequire('node:https') as typeof https;
  const dnsModule = nodeRequire('node:dns') as typeof dns;

  const restores: Restore[] = [
    patch(globalThis, 'fetch', blockedCall('fetch')),
    patch(transport, 'connect', blockedCall('net.connect')),
    patch(transport, 'createConnection', blockedCall('net.createConnection')),
    patch(transport.Socket.prototype as unknown as object, 'connect', blockedCall('net.Socket#connect')),
    patch(httpModule, 'request', blockedCall('http.request')),
    patch(httpModule, 'get', blockedCall('http.get')),
    patch(httpsModule, 'request', blockedCall('https.request')),
    patch(httpsModule, 'get', blockedCall('https.get')),
    patch(dnsModule, 'lookup', blockedCall('dns.lookup')),
    patch(dnsModule.promises as unknown as object, 'lookup', blockedCall('dns.promises.lookup')),
  ];

  try {
    // The arming probes of the previous test are deliberate; only the CLI paths below
    // must stay clean.
    attempts.length = 0;

    const cli = await import('../src/cli.ts');
    const invocations: readonly (readonly string[])[] = [
      ['--help'],
      ['--version'],
      [],
      ['search', '--config', 'config.json', '--query', 'where is authorization enforced'],
      ['inspect', '--config', 'config.json', '--json'],
      ['doctor', '--config', 'config.json'],
      ['mcp', '--config', 'config.json'],
      ['cache', 'clear', '--config', 'config.json'],
      ['frobnicate'],
    ];
    for (const argv of invocations) {
      const lines: string[] = [];
      const io: CliIo = {
        out: (line: string): void => {
          lines.push(line);
        },
        err: (line: string): void => {
          lines.push(line);
        },
      };
      const code = await cli.main(argv, io);
      assert.ok(Number.isInteger(code), `no integer exit code for '${argv.join(' ')}'`);
      assert.ok(lines.length > 0, `no output for '${argv.join(' ')}'`);
    }

    assert.deepEqual(attempts, [], `network calls were attempted: ${attempts.join(', ')}`);
  } finally {
    for (const restore of restores.reverse()) {
      restore();
    }
  }
});

test('the child-process preload blocks a provider call', () => {
  // Proof that the preload used by runCli() is armed in a real child process: the same
  // NODE_OPTIONS environment that runs the CLI must make a fetch attempt fail.
  const guarded = spawnSync(process.execPath, ['--input-type=module', '-e', "await fetch('https://example.invalid/')"], {
    env: { ...process.env, NODE_OPTIONS: `--import ${offlinePreloadUrl}` },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(guarded.status, 0, 'the preload must make a provider call fail');
  assert.match(`${guarded.stdout}${guarded.stderr}`, /offline guard blocked a fetch call/);

  // A child CLI run must behave identically with and without the preload.
  return runCli(sourceEntry, ['--version']).then((result) => {
    assert.equal(result.code, 0, result.stderr);
  });
});

test('the CLI entry point itself imports no network module', async () => {
  const source = await import('node:fs/promises').then(async (fs) =>
    fs.readFile(new URL('../src/cli.ts', import.meta.url), 'utf8'),
  );
  const imports = source.match(/^import .*'node:[^']+';$/gm) ?? [];
  assert.ok(imports.length > 0, 'no static import found in src/cli.ts');
  for (const line of imports) {
    assert.doesNotMatch(
      line,
      /node:(http|https|net|dns|tls|dgram|undici|http2)/,
      `the CLI entry point must not import a network module directly: ${line}`,
    );
  }
});
