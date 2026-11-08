import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCliArguments } from '../src/cli-args.ts';
import { executeCommand } from '../src/cli-commands.ts';
import { configurationFingerprint, doctorReport, loadConfiguration } from '../src/config.ts';
import { configurationSchema } from '../src/contracts.ts';
import { createSearchEngine } from '../src/engine.ts';
import { DecisionGatewayAdapter, type DecisionGatewayOptions } from '../src/evaluation/decision-gateway.ts';
import { batchLimits, fitsSerializedBatch, scoreCachePolicy } from '../src/evaluation/policy.ts';
import { createConfiguredProvider, serializeConfiguredBatch } from '../src/evaluation/provider.ts';
import { buildInitialConfiguration, configuredGlobalProviderSetup, discoverProjectConfiguration, environmentWithProfileSecrets, PROVIDER_KEY_VARIABLES, type InitProvider } from '../src/init.ts';
import { inspectScope } from '../src/inspect.ts';
import { createWorkspace } from './helpers/search-workspace.ts';
import { validConfiguration } from './fixtures/contracts.ts';

const providers = [
  { name: 'cloudflare', setup: { base_url: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}`, model: 'typesafe/jev' },
    env: { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) } },
  { name: 'litellm', setup: { base_url: 'https://proxy.example/gateway', model: 'jev-1.13.0' },
    env: { LITELLM_BASE_URL: 'https://proxy.example/gateway' } },
  { name: 'portkey', setup: { base_url: 'https://api.portkey.ai', model: '@typesafe-prod/jev-1.13.0' },
    env: { PORTKEY_TYPESAFE_SLUG: 'typesafe-prod' } },
] as const;

for (const { name, setup, env: setupEnv } of providers) {
  test(`${name} configuration, factory, pricing and CLI select the same adapter`, () => {
    const config = buildInitialConfiguration(validConfiguration.repository_root, name, setup);
    assert.equal(config.provider.adapter, name); assert.equal(config.provider.api_key_env, PROVIDER_KEY_VARIABLES[name]);
    assert.equal(config.provider.pricing, undefined);
    assert.equal(config.remote_evaluation_enabled, false);
    assert.ok(createConfiguredProvider(config, 'synthetic') instanceof DecisionGatewayAdapter);
    let received: DecisionGatewayOptions | undefined;
    const fake = { model: setup.model, evaluateBatch: async () => { throw new Error('unused'); } };
    assert.equal(createConfiguredProvider(config, 'synthetic', { direct: () => { throw new Error('wrong adapter'); },
      gateway: () => { throw new Error('wrong adapter'); }, decisionGateway: (options) => { received = options; return fake; } }), fake);
    assert.deepEqual(received, { adapter: name, baseUrl: setup.base_url, model: setup.model, apiKey: 'synthetic' });
    assert.deepEqual(parseCliArguments(['init', '--provider', name], { readFile: () => { throw new Error('unused'); } }), { kind: 'command', command: { kind: 'init', root: '.', global: false, provider: name } });
    assert.doesNotThrow(() => configurationSchema.parse({ ...config,
      provider: { ...config.provider, pricing: { model: setup.model, verified_at: '2026-11-09', input_usd_per_million_tokens: 0.042, output_usd_per_million_tokens: 0 } },
      scan_caps: { ...config.scan_caps, estimated_cost_usd: 1 } }));
    assert.throws(() => configurationSchema.parse({ ...config, provider: { ...config.provider, model: 'gpt-something' } }));
  });

  test(`${name} global and project init reuse non-secret settings and preserve existing project authorization`, async () => {
    const space = realpathSync.native(mkdtempSync(join(tmpdir(), 'jevgrep-gateway-profile-')));
    const root = join(space, 'repo'); mkdirSync(root);
    const env = { JEVGREP_CONFIG_HOME: join(space, 'config'), ...setupEnv };
    const errors: string[] = []; const output: string[] = [];
    const io = { out: (line: string) => output.push(line), err: (line: string) => errors.push(line) };
    try {
      assert.equal(await executeCommand({ kind: 'init', global: true, root: '.', provider: name }, io,
        { cwd: root, env, prompt: async () => 'synthetic-secret' }), 0, errors.join(''));
      assert.deepEqual(configuredGlobalProviderSetup(name, env), setup);
      assert.ok(!readFileSync(join(env.JEVGREP_CONFIG_HOME, 'global.json'), 'utf8').includes('synthetic-secret'));
      assert.equal(await executeCommand({ kind: 'init', global: false, root: '.', provider: name }, io,
        { cwd: root, env, prompt: async () => 'yes' }), 0, errors.join(''));
      const profilePath = discoverProjectConfiguration(root, env);
      const loaded = loadConfiguration(profilePath, { env });
      assert.equal(loaded.config.remote_evaluation_enabled, true); assert.equal(loaded.config.provider.adapter, name);
      assert.equal(loaded.config.provider.model, setup.model); assert.equal(loaded.config.provider.base_url, setup.base_url);
      const secrets = environmentWithProfileSecrets(profilePath, env);
      assert.equal(secrets[PROVIDER_KEY_VARIABLES[name]], 'synthetic-secret');
      const report = doctorReport(loaded, secrets);
      assert.equal(report.provider.adapter, name); assert.equal(report.provider.credential, 'present');
      assert.equal(report.cache.policy, 'rolling'); assert.equal(report.cache.effective_ttl_seconds, 900);
      assert.ok(!output.join('').includes('synthetic-secret'));
      assert.equal(await executeCommand({ kind: 'init', global: false, root: '.', provider: name }, io,
        { cwd: root, env }), 0, errors.join(''));
      assert.deepEqual(loadConfiguration(profilePath, { env }).config, loaded.config);
    } finally { rmSync(space, { recursive: true, force: true }); }
  });

  test(`${name} search and inspect account for the wire body, reuse short-lived scores, and expire them`, async (t) => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const space = createWorkspace({ files: { 'a.ts': 'export const authenticate = () => true;\n', 'b.ts': 'export const other = 1;\n' },
      configure: (config) => ({ ...config, provider: buildInitialConfiguration(config.repository_root, name, setup).provider }) });
    let calls = 0; let bytes = 0;
    const adapter = new DecisionGatewayAdapter({ adapter: name, baseUrl: setup.base_url, model: setup.model, apiKey: 'synthetic',
      transport: async (request) => {
        calls++; bytes += Buffer.byteLength(request.body);
        const payload = JSON.parse(request.body); const input = payload.input ?? payload;
        const result = { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(input.questions).map((id) => [id, { type: 'noul', noul: 0.9 }])),
          usage: { input_tokens: 100, output_tokens: 0 } };
        return { status: 200, headers: {}, text: JSON.stringify(name === 'cloudflare' ? { success: true, result } : result) };
      } });
    try {
      const query = 'Find authentication';
      const inspection = inspectScope(space.loaded, { scope: ['.'], sampleQuery: query });
      const first = (await createSearchEngine({ configuration: space.loaded, provider: adapter }).search({ query })).outcome;
      assert.ok('report' in first); assert.equal(first.status, 'complete');
      assert.equal(first.report.usage.transmitted_bytes, bytes);
      assert.equal(first.report.preflight.estimated_first_attempt_tokens, inspection.estimates.input_tokens);
      assert.equal(calls, 1);
      const second = (await createSearchEngine({ configuration: space.loaded, provider: adapter }).search({ query })).outcome;
      assert.ok('report' in second); assert.equal(second.report.fragments.cache_reused, 2); assert.equal(calls, 1);
      now += 900_001;
      await createSearchEngine({ configuration: space.loaded, provider: adapter }).search({ query }); assert.equal(calls, 2);
      const disabled = { ...space.loaded, config: { ...space.loaded.config, cache: { ...space.loaded.config.cache, rolling_ttl_seconds: 0 } } };
      await createSearchEngine({ configuration: disabled, provider: adapter }).search({ query }); assert.equal(calls, 3);
      const body = serializeConfiguredBatch(space.loaded.config, { query, items: [{ id: 'id', path: 'a.ts', startLine: 1, endLine: 1, text: 'authenticate();', label: null }] });
      const limits = batchLimits(name);
      assert.equal(limits.totalTokens, 32_000); assert.ok(fitsSerializedBatch(body, limits));
      assert.equal(fitsSerializedBatch(body, { ...limits, maxRequestBytes: Buffer.byteLength(body) - 1 }), false);
      assert.equal(fitsSerializedBatch(body, { ...limits, maxItems: 0 }), false);
      assert.deepEqual(scoreCachePolicy(name, setup.model, { enabled: true, ttl_seconds: 604800 }), { mode: 'rolling', ttlSeconds: 900 });
    } finally { space.cleanup(); }
  });

  test(`${name} interactive setup collects route settings before the key, without inference`, async (t) => {
    let network = 0; t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('offline'); });
    const space = realpathSync.native(mkdtempSync(join(tmpdir(), 'jevgrep-gateway-prompts-')));
    const root = join(space, 'repo'); mkdirSync(root);
    const env = { JEVGREP_CONFIG_HOME: join(space, 'config') };
    const route = name === 'cloudflare' ? 'a'.repeat(32) : name === 'litellm' ? setup.base_url : 'typesafe-prod';
    const answers = [String(providers.findIndex((item) => item.name === name) + 4), route, 'synthetic-secret'];
    const prompts: string[] = []; const errors: string[] = [];
    try {
      assert.equal(await executeCommand({ kind: 'init', global: true, root: '.' }, { out() {}, err: (line) => errors.push(line) },
        { cwd: root, env, prompt: async (question) => { prompts.push(question); return answers.shift() ?? ''; } }), 0, errors.join(''));
      assert.deepEqual(configuredGlobalProviderSetup(name, env), setup);
      assert.match(prompts[0]!, /Provider/); assert.ok(prompts[2]!.includes(PROVIDER_KEY_VARIABLES[name]));
      assert.equal(prompts.length, 3); assert.equal(network, 0);
    } finally { rmSync(space, { recursive: true, force: true }); }
  });
}

test('decision gateway settings refuse mismatched routes and unsafe or credential-bearing proxy URLs', () => {
  for (const { name, setup } of providers) {
    const config = buildInitialConfiguration(validConfiguration.repository_root, name, setup);
    const invalidBases = name === 'litellm'
      ? ['http://proxy.example', 'https://secret@proxy.example', 'https://proxy.example?token=secret', 'https://proxy.example/#secret',
        'https://proxy.example/a/../b', 'https://proxy.example//a', 'file:///tmp/proxy', 'https://proxy.example/%2e%2e']
      : [setup.base_url.replace('https:', 'http:'), `${setup.base_url}.evil.test`, `${setup.base_url}?token=secret`, 'https://proxy.example'];
    for (const base_url of invalidBases) {
      assert.throws(() => configurationSchema.parse({ ...config, provider: { ...config.provider, base_url } }), base_url);
      assert.throws(() => new DecisionGatewayAdapter({ adapter: name, baseUrl: base_url, model: setup.model, apiKey: 'synthetic' }), base_url);
    }
  }
  for (const base_url of ['http://localhost:4000', 'http://127.0.0.1:4000/', 'http://[::1]:4000', 'https://proxy.example/prefix']) {
    assert.doesNotThrow(() => buildInitialConfiguration(validConfiguration.repository_root, 'litellm', { base_url, model: 'jev-latest' }));
  }
  for (const name of ['cloudflare', 'portkey'] satisfies InitProvider[]) {
    assert.throws(() => buildInitialConfiguration(validConfiguration.repository_root, name));
  }
});

test('gateway cache identities isolate account, proxy and integration settings', () => {
  const configs = providers.map(({ name, setup }) => buildInitialConfiguration(validConfiguration.repository_root, name, setup));
  for (const config of configs) {
    const original = configurationFingerprint(config, config.repository_root);
    const provider = config.provider.adapter === 'cloudflare' ? { ...config.provider, base_url: config.provider.base_url.replace(/a{32}/, 'b'.repeat(32)) }
      : config.provider.adapter === 'litellm' ? { ...config.provider, base_url: 'https://other-proxy.example' }
      : { ...config.provider, model: '@other-integration/jev-1.13.0' };
    assert.notEqual(configurationFingerprint({ ...config, provider }, config.repository_root), original);
  }
});

for (const name of ['litellm', 'portkey'] as const) {
  test(`${name} never reuses a score from a mismatched returned revision`, async () => {
    const setup = providers.find((provider) => provider.name === name)!.setup;
    const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' },
      configure: (config) => ({ ...config, provider: buildInitialConfiguration(config.repository_root, name, setup).provider }) });
    let calls = 0;
    const adapter = new DecisionGatewayAdapter({ adapter: name, baseUrl: setup.base_url, model: setup.model, apiKey: 'synthetic',
      transport: async (request) => {
        calls++; const body = JSON.parse(request.body);
        return { status: 200, headers: {}, text: JSON.stringify({ model: 'jev-1.14.0',
          answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.9 }])) }) };
      } });
    try {
      const engine = createSearchEngine({ configuration: space.loaded, provider: adapter });
      await engine.search({ query: 'q' }); await engine.search({ query: 'q' });
      assert.equal(calls, 2); assert.equal(engine.cache.stats.writes, 0);
    } finally { space.cleanup(); }
  });
}
