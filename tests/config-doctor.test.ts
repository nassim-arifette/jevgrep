import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  ConfigurationError, createDefaultConfiguration, doctorReport, loadConfiguration,
  renderDoctorReport, resolveCredential,
} from '../src/config.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

/**
 * Trusted configuration and the local `doctor` state (JG-007).
 *
 * Everything here runs offline and without a credential: that is the point of the
 * issue. A repository must not be able to widen its own authorization, an optional
 * cap must stay disabled unless the operator enabled it, and `doctor` must be usable
 * before anything is ever sent.
 */
const workspaces: { cleanup(): void }[] = [];

function workspace(options: Parameters<typeof createWorkspace>[0] = {}): ReturnType<typeof createWorkspace> {
  const created = createWorkspace(options);
  workspaces.push(created);
  return created;
}

after(() => {
  for (const created of workspaces) {
    created.cleanup();
  }
});

test('a generated configuration starts with remote evaluation disabled and every cap off', () => {
  const space = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const { config } = space.loaded;
  assert.equal(config.remote_evaluation_enabled, false);
  for (const [key, value] of Object.entries(config.scan_caps)) {
    assert.equal(value, null, `${key} must be disabled by default`);
  }
  assert.equal(config.source.follow_links, false);
  assert.equal(config.logging.include_source, false);
  assert.equal(config.search.deadline_ms, 60_000);
  assert.equal(config.search.default_response_tokens, 4_000);
});

test('the configuration must live outside the repository it authorizes', () => {
  const space = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const inside = join(space.repositoryRoot, 'jevgrep.config.json');
  writeFileSync(inside, `${JSON.stringify(createDefaultConfiguration(space.repositoryRoot.split('\\').join('/'), 'jev-1.13.0'))}\n`);
  assert.throws(
    () => loadConfiguration(inside, { env: space.env }),
    (error: unknown) => error instanceof ConfigurationError && error.code === 'INVALID_CONFIG'
      && /outside the repository/.test(error.detail),
  );
});

test('unsupported options are refused instead of silently ignored', () => {
  const space = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const base = createDefaultConfiguration(space.repositoryRoot.split('\\').join('/'), 'jev-1.13.0');
  const cases: [string, unknown][] = [
    ['follow_links', { ...base, source: { ...base.source, follow_links: true } }],
    ['include_source', { ...base, logging: { ...base.logging, include_source: true } }],
    ['unknown key', { ...base, telemetry: { enabled: true } }],
    ['unsupported endpoint', { ...base, provider: { ...base.provider, base_url: 'https://evil.example.com' } }],
    ['usd cap without pricing', { ...base, scan_caps: { ...base.scan_caps, estimated_cost_usd: 1 } }],
    ['zero as unlimited', { ...base, search: { ...base.search, deadline_ms: 0 } }],
  ];
  for (const [label, candidate] of cases) {
    const path = join(space.root, `bad-${label.replace(/\W+/g, '-')}.json`);
    writeFileSync(path, `${JSON.stringify(candidate)}\n`);
    assert.throws(
      () => loadConfiguration(path, { env: space.env }),
      (error: unknown) => error instanceof ConfigurationError && error.code === 'INVALID_CONFIG',
      `${label} should be refused`,
    );
  }
});

test('a missing secret and a disabled disclosure are different, actionable failures', () => {
  const disabled = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  assert.throws(
    () => resolveCredential(disabled.loaded, {}),
    (error: unknown) => error instanceof ConfigurationError && error.code === 'REMOTE_DISABLED',
  );

  const enabled = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' }, configure: withRemoteEnabled });
  assert.throws(
    () => resolveCredential(enabled.loaded, {}),
    (error: unknown) => error instanceof ConfigurationError && error.code === 'CREDENTIAL_MISSING'
      && error.detail.includes('TYPESAFE_API_KEY'),
  );
  assert.equal(resolveCredential(enabled.loaded, { TYPESAFE_API_KEY: 'secret-value' }), 'secret-value');
  assert.throws(
    () => resolveCredential(enabled.loaded, { TYPESAFE_API_KEY: '   ' }),
    (error: unknown) => error instanceof ConfigurationError && error.code === 'CREDENTIAL_MISSING',
  );
});

test('doctor reports the useful state without a key and without printing the secret', () => {
  const space = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' }, configure: withRemoteEnabled });
  const report = doctorReport(space.loaded, { TYPESAFE_API_KEY: 'super-secret-value' });
  const text = renderDoctorReport(report).join('\n');

  assert.equal(report.provider.credential, 'present');
  assert.equal(report.provider.adapter, 'typesafe-direct');
  assert.ok(text.includes('typesafe-direct'));
  assert.ok(!text.includes('super-secret-value'), 'doctor must never print the credential value');
  assert.ok(text.includes('TYPESAFE_API_KEY'), 'doctor names the variable it reads');
  assert.ok(text.includes(space.repositoryRoot), 'doctor states the authorized root');
  assert.ok(text.includes('all disabled (null)'), 'doctor states that optional caps are off');
  assert.ok(text.includes('tiktoken@1.0.22/cl100k_base'), 'doctor names the response counter');
  assert.deepEqual(report.disabled_scan_caps.length, 7);
  assert.equal(report.pricing, null);

  const withoutKey = doctorReport(space.loaded, {});
  assert.equal(withoutKey.provider.credential, 'missing');
  assert.ok(withoutKey.problems.some((problem) => problem.includes('TYPESAFE_API_KEY')));
});

test('doctor identifies Vercel AI Gateway and its credential without contacting it', () => {
  const space = workspace({
    files: { 'src/a.ts': 'export const a = 1;\n' },
    configure: (config) => ({
      ...config,
      provider: {
        adapter: 'vercel-ai-gateway',
        base_url: 'https://ai-gateway.vercel.sh',
        api_key_env: 'AI_GATEWAY_API_KEY',
        model: 'typesafe-ai/jev',
      },
    }),
  });
  const report = doctorReport(space.loaded, { AI_GATEWAY_API_KEY: 'synthetic-gateway-secret' });
  const text = renderDoctorReport(report).join('\n');
  assert.equal(report.provider.adapter, 'vercel-ai-gateway');
  assert.equal(report.provider.credential, 'not_required');
  assert.match(text, /vercel-ai-gateway.*ai-gateway\.vercel\.sh.*typesafe-ai\/jev/);
  assert.equal(text.includes('synthetic-gateway-secret'), false);
});

test('doctor explains a disabled disclosure rather than reporting a missing key', () => {
  const space = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  const report = doctorReport(space.loaded, {});
  assert.equal(report.provider.credential, 'not_required');
  assert.ok(report.problems.some((problem) => problem.includes('remote evaluation is disabled')));
  assert.ok(renderDoctorReport(report).join('\n').includes('no excerpt leaves this machine'));
});

test('an enabled cap is reported with its value, a disabled one stays null', () => {
  const space = workspace({
    files: { 'src/a.ts': 'export const a = 1;\n' },
    configure: (config) => ({ ...config, scan_caps: { ...config.scan_caps, request_attempts: 12 } }),
  });
  const report = doctorReport(space.loaded, {});
  assert.deepEqual(report.enabled_scan_caps, { request_attempts: 12 });
  assert.ok(!report.disabled_scan_caps.includes('request_attempts'));
  assert.ok(renderDoctorReport(report).join('\n').includes('request_attempts: 12'));
});

test('the cache directory is derived per root and never inside the repository', () => {
  const space = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  assert.ok(!space.loaded.cacheDirectory.startsWith(space.repositoryRoot));
  assert.ok(space.loaded.cacheDirectory.includes(space.loaded.fingerprint));

  const other = workspace({ files: { 'src/a.ts': 'export const a = 1;\n' } });
  assert.notEqual(space.loaded.fingerprint, other.loaded.fingerprint);
});

test('a missing or malformed configuration file is a configuration error, not a crash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jevgrep-config-'));
  const broken = join(directory, 'broken.json');
  writeFileSync(broken, '{ not json');
  try {
    assert.throws(
      () => loadConfiguration(join(directory, 'absent.json'), {}),
      (error: unknown) => error instanceof ConfigurationError && error.code === 'INVALID_CONFIG',
    );
    assert.throws(
      () => loadConfiguration(broken, {}),
      (error: unknown) => error instanceof ConfigurationError && /not valid JSON/.test(error.detail),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
