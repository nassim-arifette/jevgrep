import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

import { configurationSchema, createDefaultConfiguration, type Configuration } from './contracts.ts';
import { LocalDirectory, isMissing } from './local-directory.ts';
import { AuthorizedRoot } from './source/authorization.ts';

export type InitProvider = 'typesafe' | 'vercel';

export const DEFAULT_JEVGREPIGNORE = `# JevGrep already respects .gitignore.
#
# The following are also excluded automatically for security:
# credentials, dependencies, build outputs, binaries, and oversized files.
#
# Add versioned content that is not useful for search below.
`;

export function configurationHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['JEVGREP_CONFIG_HOME'];
  if (override && isAbsolute(override)) return resolve(override);
  if (process.platform === 'win32') return resolve(env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'jevgrep');
  const xdg = env['XDG_CONFIG_HOME'];
  return resolve(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'jevgrep');
}

function safeName(root: string): string {
  const name = basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
  return `${name}-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
}

export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string { return join(configurationHome(env), 'global.json'); }
export function globalSecretsPath(env: NodeJS.ProcessEnv = process.env): string { return join(configurationHome(env), 'secrets.env'); }

/** Preflight runs before prompting for a key or writing any global/project state. */
export function validateProfileLocation(rootPath: string, env: NodeJS.ProcessEnv): AuthorizedRoot {
  const root = AuthorizedRoot.open(resolve(rootPath));
  new LocalDirectory(configurationHome(env), root);
  return root;
}

function readOptional(storage: LocalDirectory, name: string, limit: number): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(storage.read(name, limit)); }
  catch (cause) { if (isMissing(cause)) return undefined; throw new Error(`cannot read local settings at ${join(storage.path, name)}`); }
}

function parseJson(text: string, path: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`invalid JSON settings at ${path}`); }
}

export function projectConfigurationPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const authorized = validateProfileLocation(root, env);
  return join(configurationHome(env), 'profiles', safeName(authorized.path), 'config.json');
}

type GlobalSettings = { readonly schema_version: 1; readonly provider: InitProvider };
function readGlobalSettings(env: NodeJS.ProcessEnv): GlobalSettings | undefined {
  const text = readOptional(new LocalDirectory(configurationHome(env)), 'global.json', 16_384);
  if (text === undefined) return undefined;
  const parsed = parseJson(text, globalSettingsPath(env));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid global settings');
  const value = parsed as Record<string, unknown>;
  if (value['schema_version'] !== 1 || (value['provider'] !== 'typesafe' && value['provider'] !== 'vercel')
    || Object.keys(value).some((key) => !['schema_version', 'provider'].includes(key))) throw new Error('invalid global settings');
  return { schema_version: 1, provider: value['provider'] };
}

export function configuredGlobalProvider(env: NodeJS.ProcessEnv = process.env): InitProvider | undefined { return readGlobalSettings(env)?.provider; }

type GlobalProfileOptions = {
  readonly provider: InitProvider; readonly apiKey: string; readonly env?: NodeJS.ProcessEnv;
  readonly repositoryRoot?: AuthorizedRoot;
};
type GlobalProfile = { readonly settingsPath: string; readonly secretsPath: string; readonly variable: string };

function validateKey(key: string): void {
  if (key.trim().length === 0 || /[\r\n]/.test(key) || Buffer.byteLength(key) > 8_192) throw new Error('the API key must be non-empty, bounded and one line');
}

function parseSecrets(text: string, path: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null || Object.hasOwn(values, match[1]!)) throw new Error(`invalid secrets file ${path}`);
    values[match[1]!] = match[2]!;
  }
  return values;
}

function writeGlobalProfile(options: GlobalProfileOptions, replace: boolean): GlobalProfile {
  validateKey(options.apiKey);
  const env = options.env ?? process.env;
  const root = options.repositoryRoot;
  root?.assertCurrent();
  const storage = new LocalDirectory(configurationHome(env), root);
  const existingSettings = readOptional(storage, 'global.json', 16_384);
  const existingSecrets = readOptional(storage, 'secrets.env', 32_768);
  if (!replace && (existingSettings !== undefined || existingSecrets !== undefined)) throw new Error(`global settings already exist at ${storage.path}`);
  const variable = options.provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY';
  // Retain the other provider's key: existing project profiles may still use it.
  const secrets = parseSecrets(existingSecrets ?? '', join(storage.path, 'secrets.env'));
  secrets[variable] = options.apiKey.trim();
  root?.assertCurrent();
  storage.write('secrets.env', Object.entries(secrets).map(([key, value]) => `${key}=${value}\n`).join(''), !replace);
  try { storage.write('global.json', `${JSON.stringify({ schema_version: 1, provider: options.provider }, null, 2)}\n`, !replace); }
  catch (cause) { if (!replace) storage.remove('secrets.env'); throw cause; }
  return { settingsPath: join(storage.path, 'global.json'), secretsPath: join(storage.path, 'secrets.env'), variable };
}

export function createGlobalProfile(options: GlobalProfileOptions): GlobalProfile { return writeGlobalProfile(options, false); }
export function updateGlobalProfile(options: GlobalProfileOptions): GlobalProfile { return writeGlobalProfile(options, true); }

export function discoverProjectConfiguration(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  let candidate = AuthorizedRoot.open(resolve(cwd)).path;
  const storage = new LocalDirectory(configurationHome(env));
  for (;;) {
    const relative = `profiles/${safeName(candidate)}/config.json`;
    if (readOptional(storage, relative, 1_048_576) !== undefined) return join(storage.path, relative);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`no JevGrep project is configured for ${resolve(cwd)}; run 'jevgrep init' in the repository first`);
}

export function buildInitialConfiguration(root: string, provider: InitProvider): Configuration {
  const config = createDefaultConfiguration(root, provider === 'typesafe' ? 'jev-latest' : 'typesafe-ai/jev');
  return configurationSchema.parse({
    ...config,
    provider: provider === 'typesafe'
      ? { ...config.provider, adapter: 'typesafe-direct', base_url: 'https://api.typesafe.ai', api_key_env: 'TYPESAFE_API_KEY' }
      : {
        ...config.provider, adapter: 'vercel-ai-gateway', base_url: 'https://ai-gateway.vercel.sh',
        api_key_env: 'AI_GATEWAY_API_KEY', model: 'typesafe-ai/jev',
        pricing: { model: 'typesafe-ai/jev', verified_at: '2026-09-20', input_usd_per_million_tokens: 0.04, output_usd_per_million_tokens: 0 },
      },
  });
}

export type CreatedProfile = { readonly configPath: string; readonly secretsPath: string; readonly variable: string };

function createDefaultIgnoreFile(root: AuthorizedRoot): boolean {
  const repository = new LocalDirectory(root.path);
  try { root.resolveEntry('.jevgrepignore'); return false; }
  catch (cause) { if (!isMissing(cause)) throw cause; }
  try { repository.write('.jevgrepignore', DEFAULT_JEVGREPIGNORE, true); return true; }
  catch (cause) {
    try { root.resolveEntry('.jevgrepignore'); return false; }
    catch { throw cause; }
  }
}

export function createProfile(options: {
  readonly root: string; readonly provider: InitProvider; readonly apiKey?: string; readonly env?: NodeJS.ProcessEnv;
  readonly replaceProvider?: boolean;
}): CreatedProfile {
  if (options.apiKey !== undefined) validateKey(options.apiKey);
  const env = options.env ?? process.env;
  const root = validateProfileLocation(options.root, env);
  const storage = new LocalDirectory(join(configurationHome(env), 'profiles', safeName(root.path)), root);
  const configPath = join(storage.path, 'config.json');
  const secretsPath = options.apiKey === undefined ? globalSecretsPath(env) : join(storage.path, 'secrets.env');
  const existing = readOptional(storage, 'config.json', 1_048_576);
  const desired = buildInitialConfiguration(root.path, options.provider);
  if (existing !== undefined) {
    if (options.replaceProvider !== true || options.apiKey !== undefined) throw new Error(`a profile already exists at ${storage.path}`);
    const current = configurationSchema.parse(parseJson(existing, configPath));
    if (AuthorizedRoot.open(current.repository_root).path !== root.path) throw new Error('the existing profile authorizes another repository');
    const updated = configurationSchema.parse({ ...current, provider: desired.provider });
    root.assertCurrent(); storage.write('config.json', `${JSON.stringify(updated, null, 2)}\n`);
    return { configPath, secretsPath, variable: updated.provider.api_key_env };
  }
  if (options.apiKey !== undefined && readOptional(storage, 'secrets.env', 32_768) !== undefined) throw new Error(`a profile already exists at ${storage.path}`);
  root.assertCurrent(); storage.write('config.json', `${JSON.stringify(desired, null, 2)}\n`, true);
  let ignoreCreated = false;
  let secretsCreated = false;
  try {
    if (options.apiKey !== undefined) {
      storage.write('secrets.env', `${desired.provider.api_key_env}=${options.apiKey.trim()}\n`, true);
      secretsCreated = true;
    }
    ignoreCreated = createDefaultIgnoreFile(root);
  } catch (cause) {
    storage.remove('config.json');
    if (secretsCreated) storage.remove('secrets.env');
    if (ignoreCreated) new LocalDirectory(root.path).remove('.jevgrepignore');
    throw cause;
  }
  return { configPath, secretsPath, variable: desired.provider.api_key_env };
}

export function environmentWithProfileSecrets(
  configPath: string, base: NodeJS.ProcessEnv, repositoryRoot?: AuthorizedRoot, allowedVariable?: string,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  const profileDirectory = dirname(configPath);
  const profilesDirectory = dirname(profileDirectory);
  const paths = basename(profilesDirectory) === 'profiles'
    ? [join(dirname(profilesDirectory), 'secrets.env'), join(profileDirectory, 'secrets.env')]
    : [globalSecretsPath(base), join(profileDirectory, 'secrets.env')];
  for (const path of [...new Set(paths)]) {
    repositoryRoot?.assertCurrent();
    const text = readOptional(new LocalDirectory(dirname(path), repositoryRoot), basename(path), 32_768);
    if (text === undefined) continue;
    for (const [key, value] of Object.entries(parseSecrets(text, path))) if (allowedVariable === undefined || key === allowedVariable) merged[key] = value;
  }
  return { ...merged, ...base };
}
