import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { executeCommand } from '../src/cli-commands.ts';
import { LocalDirectory } from '../src/local-directory.ts';

import {
  configuredGlobalProvider, createGlobalProfile, createProfile, DEFAULT_JEVGREPIGNORE, discoverProjectConfiguration,
  environmentWithProfileSecrets, updateGlobalProfile,
} from '../src/init.ts';

const spaces: string[] = [];
function temporary(prefix: string): string { const space = mkdtempSync(join(tmpdir(), prefix)); spaces.push(space); return space; }
after(() => { for (const space of spaces) rmSync(space, { recursive: true, force: true }); });

test('failed initialization preserves a secret created concurrently by another writer', (t) => {
  const space = temporary('jevgrep-init-exclusive-'); const root = join(space, 'repository'); mkdirSync(root);
  const env = { JEVGREP_CONFIG_HOME: join(space, 'configuration') };
  let competingSecret = '';
  const original = LocalDirectory.prototype.write;
  t.mock.method(LocalDirectory.prototype, 'write', function (this: LocalDirectory, name: string, text: string, exclusive?: boolean) {
    if (name === 'secrets.env') { competingSecret = join(this.path, name); writeFileSync(competingSecret, 'TYPESAFE_API_KEY=another-writer\n', { flag: 'wx' }); }
    return original.call(this, name, text, exclusive);
  });
  assert.throws(() => createProfile({ root, provider: 'typesafe', apiKey: 'ours', env }), /already exists/);
  assert.equal(readFileSync(competingSecret, 'utf8'), 'TYPESAFE_API_KEY=another-writer\n');
});

test('init refuses a repository-local home before prompting for or writing a credential', async () => {
  const space = temporary('jevgrep-init-refusal-');
  const configHome = join(space, 'configuration');
  let prompts = 0; const errors: string[] = [];
  const code = await executeCommand({ kind: 'init', root: '.', global: false }, { out() {}, err: (line) => errors.push(line) }, {
    cwd: space, env: { JEVGREP_CONFIG_HOME: configHome }, prompt: async () => { prompts++; return 'synthetic'; },
  });
  assert.equal(code, 2); assert.equal(prompts, 0); assert.equal(existsSync(configHome), false); assert.match(errors.join(''), /outside/);
});

test('init resolves a relative root from the command cwd and keeps disclosure disabled', async () => {
  const space = temporary('jevgrep-init-relative-'); const root = join(space, 'repository'); mkdirSync(root);
  const env = { JEVGREP_CONFIG_HOME: join(space, 'configuration'), TYPESAFE_API_KEY: 'synthetic' };
  const errors: string[] = [];
  const code = await executeCommand({ kind: 'init', root: 'repository', global: false, provider: 'typesafe' }, { out() {}, err: (line) => errors.push(line) }, { cwd: space, env });
  assert.equal(code, 0, errors.join(''));
  const config = JSON.parse(readFileSync(discoverProjectConfiguration(root, env), 'utf8')) as { repository_root: string; remote_evaluation_enabled: boolean };
  assert.equal(config.repository_root, root); assert.equal(config.remote_evaluation_enabled, false);
});

test('global setup from the user home does not authorize the home as a repository', async () => {
  const home = temporary('jevgrep-init-global-home-');
  const env = { JEVGREP_CONFIG_HOME: join(home, '.config', 'jevgrep'), TYPESAFE_API_KEY: 'synthetic' };
  const errors: string[] = [];
  assert.equal(await executeCommand({ kind: 'init', root: '.', global: true, provider: 'typesafe' }, { out() {}, err: (line) => errors.push(line) }, { cwd: home, env }), 0, errors.join(''));
  assert.equal(configuredGlobalProvider(env), 'typesafe');
  assert.equal(existsSync(join(env.JEVGREP_CONFIG_HOME, 'profiles')), false);
});

test('linked profile homes and oversized or malformed secret/settings files are refused', () => {
  const space = temporary('jevgrep-init-guard-'); const root = join(space, 'repository'); const outside = join(space, 'outside');
  mkdirSync(root); mkdirSync(outside); const linked = join(space, 'linked');
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createProfile({ root, provider: 'typesafe', env: { JEVGREP_CONFIG_HOME: linked } }));
  const env = { JEVGREP_CONFIG_HOME: outside };
  writeFileSync(join(outside, 'global.json'), '{ synthetic-secret');
  assert.throws(() => configuredGlobalProvider(env), (cause: unknown) => cause instanceof Error && !cause.message.includes('synthetic-secret'));
  writeFileSync(join(outside, 'secrets.env'), `TYPESAFE_API_KEY=${'x'.repeat(33_000)}`);
  assert.throws(() => environmentWithProfileSecrets(join(outside, 'config.json'), env), /cannot read local settings/);
});

test('init creates a TypeSafe-first trusted profile outside the repository', () => {
  const space = temporary('jevgrep-init-');
  const repository = join(space, 'repository');
  const configHome = join(space, 'configuration');
  mkdirSync(repository);
  const profile = createProfile({
    root: repository, provider: 'typesafe', apiKey: 'secret-value',
    env: { JEVGREP_CONFIG_HOME: configHome },
  });
  const config = JSON.parse(readFileSync(profile.configPath, 'utf8')) as Record<string, unknown>;
  const provider = config['provider'] as Record<string, unknown>;
  assert.equal(config['remote_evaluation_enabled'], false);
  assert.equal(provider['adapter'], 'typesafe-direct');
  assert.equal(provider['api_key_env'], 'TYPESAFE_API_KEY');
  assert.ok(!readFileSync(profile.configPath, 'utf8').includes('secret-value'));
  assert.equal(environmentWithProfileSecrets(profile.configPath, {})['TYPESAFE_API_KEY'], 'secret-value');
  assert.equal(readFileSync(join(repository, '.jevgrepignore'), 'utf8'), DEFAULT_JEVGREPIGNORE);
});

test('init preserves an existing repository .jevgrepignore', () => {
  const space = temporary('jevgrep-init-ignore-');
  const repository = join(space, 'repository');
  const configHome = join(space, 'configuration');
  mkdirSync(repository);
  writeFileSync(join(repository, '.jevgrepignore'), 'public/generated/\n');
  createProfile({ root: repository, provider: 'typesafe', env: { JEVGREP_CONFIG_HOME: configHome } });
  assert.equal(readFileSync(join(repository, '.jevgrepignore'), 'utf8'), 'public/generated/\n');
});

test('an explicit provider choice can replace the global provider and credential', () => {
  const space = temporary('jevgrep-init-switch-');
  const env = { JEVGREP_CONFIG_HOME: join(space, 'configuration') };
  createGlobalProfile({ provider: 'typesafe', apiKey: 'old-secret', env });
  updateGlobalProfile({ provider: 'vercel', apiKey: 'gateway-secret', env });
  assert.equal(configuredGlobalProvider(env), 'vercel');
  const repository = join(space, 'repository');
  mkdirSync(repository);
  const profile = createProfile({ root: repository, provider: 'vercel', env });
  const secrets = environmentWithProfileSecrets(profile.configPath, {});
  assert.equal(secrets['AI_GATEWAY_API_KEY'], 'gateway-secret');
  assert.equal(secrets['TYPESAFE_API_KEY'], 'old-secret', 'existing TypeSafe project profiles retain their credential');
});

test('an explicit provider choice updates an existing project profile', () => {
  const space = temporary('jevgrep-init-project-switch-');
  const repository = join(space, 'repository');
  const env = { JEVGREP_CONFIG_HOME: join(space, 'configuration') };
  mkdirSync(repository);
  createProfile({ root: repository, provider: 'typesafe', apiKey: 'legacy-secret', env });
  const profile = createProfile({ root: repository, provider: 'vercel', env, replaceProvider: true });
  const config = JSON.parse(readFileSync(profile.configPath, 'utf8')) as { provider: { adapter: string; model: string } };
  assert.equal(config.provider.adapter, 'vercel-ai-gateway');
  assert.equal(config.provider.model, 'typesafe-ai/jev');
});

test('process environment overrides the profile secret and Vercel uses its own variable', () => {
  const space = temporary('jevgrep-init-');
  const repository = join(space, 'repository');
  mkdirSync(repository);
  const profile = createProfile({
    root: repository, provider: 'vercel', apiKey: 'file-secret',
    env: { JEVGREP_CONFIG_HOME: join(space, 'configuration') },
  });
  const environment = environmentWithProfileSecrets(profile.configPath, { AI_GATEWAY_API_KEY: 'environment-secret' });
  assert.equal(environment['AI_GATEWAY_API_KEY'], 'environment-secret');
});

test('a Vercel profile records the dated Jev rate used for cost estimates', () => {
  const space = temporary('jevgrep-init-vercel-pricing-');
  const repository = join(space, 'repository');
  mkdirSync(repository);
  const profile = createProfile({
    root: repository, provider: 'vercel', apiKey: 'file-secret',
    env: { JEVGREP_CONFIG_HOME: join(space, 'configuration') },
  });
  const config = JSON.parse(readFileSync(profile.configPath, 'utf8')) as {
    provider: { pricing: Record<string, unknown> };
  };
  assert.deepEqual(config.provider.pricing, {
    model: 'typesafe-ai/jev',
    verified_at: '2026-09-20',
    input_usd_per_million_tokens: 0.042,
    output_usd_per_million_tokens: 0,
  });
});

test('a global provider and secret are reused by project profiles discovered from subdirectories', () => {
  const space = temporary('jevgrep-init-global-');
  const repository = join(space, 'repository');
  const nested = join(repository, 'src', 'feature');
  const configHome = join(space, 'configuration');
  mkdirSync(nested, { recursive: true });
  const env = { JEVGREP_CONFIG_HOME: configHome };

  createGlobalProfile({ provider: 'typesafe', apiKey: 'global-secret', env });
  const profile = createProfile({ root: repository, provider: 'typesafe', env });

  assert.equal(configuredGlobalProvider(env), 'typesafe');
  assert.equal(discoverProjectConfiguration(nested, env), profile.configPath);
  assert.equal(environmentWithProfileSecrets(profile.configPath, {})['TYPESAFE_API_KEY'], 'global-secret');
  assert.ok(!readFileSync(profile.configPath, 'utf8').includes('global-secret'));
});
