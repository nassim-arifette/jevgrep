import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { parseCliArguments } from '../src/cli-args.ts';
import { executeCommand } from '../src/cli-commands.ts';
import type { Configuration } from '../src/contracts.ts';
import { configuredGlobalProvider, createGlobalProfile, discoverProjectConfiguration, environmentWithProfileSecrets, globalSecretsPath } from '../src/init.ts';

function workspace() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'jevgrep-init-repeat-')));
  const root = join(base, 'repository');
  mkdirSync(root);
  writeFileSync(join(root, 'source.txt'), 'harmless source\n');
  const env = { JEVGREP_CONFIG_HOME: join(base, 'configuration') };
  const out: string[] = [];
  const io = { out: (text: string) => out.push(text), err: (text: string) => assert.fail(text) };
  return { root, env, out, io, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('decline, inspect, then accept works and preserves every tuned setting', async () => {
  const space = workspace();
  try {
    createGlobalProfile({ provider: 'typesafe', apiKey: 'initial', env: space.env });
    const command = { kind: 'init' as const, root: '.', global: false };
    assert.equal(await executeCommand(command, space.io, { cwd: space.root, env: space.env, prompt: async () => 'n' }), 0);
    const configPath = discoverProjectConfiguration(space.root, space.env);
    const initial = JSON.parse(readFileSync(configPath, 'utf8')) as Configuration;
    const tuned = { ...initial, provider: { ...initial.provider, model: 'jev-1.14.0' },
      source: { ...initial.source, max_file_bytes: 123_456, extra_deny_globs: ['private/**'] },
      cache: { ...initial.cache, ttl_seconds: 123 },
    };
    writeFileSync(configPath, JSON.stringify(tuned));
    assert.equal(await executeCommand({ kind: 'inspect', scope: ['.'], json: true }, space.io, {
      cwd: space.root, env: space.env,
    }), 0);
    const prompts: string[] = [];
    assert.equal(await executeCommand(command, space.io, {
      cwd: space.root, env: space.env, prompt: async (question) => { prompts.push(question); return 'yes'; },
    }), 0);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /TypeSafe AI/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { ...tuned, remote_evaluation_enabled: true });
    assert.equal(await executeCommand(command, space.io, { cwd: space.root, env: space.env, input: new PassThrough() }), 0);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { ...tuned, remote_evaluation_enabled: true });
    assert.equal(await executeCommand({ ...command, provider: 'typesafe' }, space.io, {
      cwd: space.root, env: space.env, prompt: async () => 'yes',
    }), 0);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { ...tuned, remote_evaluation_enabled: true });
  } finally { space.cleanup(); }
});

test('reauthorization retains the project provider after the computer default changes', async () => {
  const space = workspace();
  try {
    createGlobalProfile({ provider: 'typesafe', apiKey: 'initial', env: space.env });
    const command = { kind: 'init' as const, root: '.', global: false };
    assert.equal(await executeCommand(command, space.io, { cwd: space.root, env: space.env, prompt: async () => 'n' }), 0);
    const configPath = discoverProjectConfiguration(space.root, space.env);
    const initial = JSON.parse(readFileSync(configPath, 'utf8')) as Configuration;
    assert.equal(await executeCommand({ kind: 'init', root: '.', global: true, provider: 'vercel' }, space.io, {
      cwd: space.root, env: { ...space.env, AI_GATEWAY_API_KEY: 'gateway' },
    }), 0);
    assert.equal(configuredGlobalProvider(space.env), 'vercel');
    assert.equal(await executeCommand(command, space.io, {
      cwd: space.root, env: space.env,
      prompt: async (question) => { assert.match(question, /TypeSafe AI/); return 'yes'; },
    }), 0);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { ...initial, remote_evaluation_enabled: true });
    assert.equal(configuredGlobalProvider(space.env), 'vercel');
  } finally { space.cleanup(); }
});

test('explicit key replacement prompts even with an old environment key and preserves other provider keys', async () => {
  const space = workspace();
  try {
    createGlobalProfile({ provider: 'typesafe', apiKey: 'old-stored', env: space.env });
    const command = { kind: 'init' as const, root: '.', global: true };
    assert.equal(await executeCommand(command, space.io, {
      cwd: space.root, env: space.env, prompt: async () => assert.fail('already configured'),
    }), 0);
    assert.match(space.out.join('\n'), /--replace-key/);
    assert.equal(await executeCommand({ ...command, replaceKey: true }, space.io, {
      cwd: space.root, env: { ...space.env, TYPESAFE_API_KEY: 'old-environment' },
      prompt: async () => assert.fail('only the credential prompt should run'),
      promptSecret: async (question) => { assert.match(question, /TYPESAFE_API_KEY.*hidden/); return 'new-stored'; },
    }), 0);
    assert.equal(readFileSync(globalSecretsPath(space.env), 'utf8'), 'TYPESAFE_API_KEY=new-stored\n');
    assert.equal(await executeCommand({ ...command, provider: 'vercel' }, space.io, {
      cwd: space.root, env: { ...space.env, AI_GATEWAY_API_KEY: 'gateway' },
    }), 0);
    assert.match(readFileSync(globalSecretsPath(space.env), 'utf8'), /TYPESAFE_API_KEY=new-stored\nAI_GATEWAY_API_KEY=gateway\n/);
    assert.ok(!space.out.join('\n').includes('new-stored'));
  } finally { space.cleanup(); }
});

class TerminalInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(enabled: boolean): this { this.isRaw = enabled; return this; }
}

for (const cancel of [false, true]) {
  test(`interactive credential input hides bytes and restores terminal mode (${cancel ? 'interrupted' : 'success'})`, { timeout: 2_000 }, async () => {
    const space = workspace();
    const input = new TerminalInput();
    const output = new PassThrough();
    const shown: string[] = [];
    output.on('data', (chunk: Buffer) => shown.push(chunk.toString()));
    try {
      const result = executeCommand({ kind: 'init', root: '.', global: true, provider: 'typesafe' }, space.io, {
        cwd: space.root, env: space.env, input, output,
      });
      setImmediate(() => input.write(cancel ? 'partial-secret\u0003' : 'terminal-secret\r'));
      assert.equal(await result, cancel ? 130 : 0);
      assert.equal(input.isRaw, false);
      assert.match(shown.join(''), /TYPESAFE_API_KEY/);
      assert.ok(!shown.join('').includes('secret'));
      if (!cancel) {
        const profileEnvironment = environmentWithProfileSecrets(join(space.env.JEVGREP_CONFIG_HOME, 'config.json'), space.env);
        assert.equal(profileEnvironment['TYPESAFE_API_KEY'], 'terminal-secret');
      } else assert.equal(existsSync(globalSecretsPath(space.env)), false);
    } finally { input.destroy(); output.destroy(); space.cleanup(); }
  });
}

test('key replacement is explicit and limited to global initialization', () => {
  const parse = (args: string[]) => parseCliArguments(args, { readFile: () => '' });
  assert.deepEqual(parse(['init', '--global', '--replace-key']), {
    kind: 'command', command: { kind: 'init', root: '.', global: true, replaceKey: true },
  });
  for (const args of [['init', '--replace-key'], ['init', '--global', '--replace-key', '--replace-key']]) {
    assert.equal(parse(args).kind, 'error');
  }
});
