/**
 * Trusted configuration loading and the local `doctor` state (JG-007).
 *
 * The operator, not the searched repository, decides the authorized root, remote
 * disclosure, the provider destination and the resource ceilings (specification
 * section 5.1). This module therefore only ever reads the configuration file it was
 * explicitly given, refuses a file that lives inside the repository it authorizes,
 * and takes the provider secret from the environment instead of the file.
 *
 * Nothing here contacts a provider: `doctor` must work offline, without a key.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import process from 'node:process';

import {
  CONFIG_SCHEMA_VERSION, ContractValidationError, SCAN_CAP_KEYS, configurationSchema,
  createDefaultConfiguration,
} from './contracts.ts';
import type { Configuration, ErrorCode, ScanCap } from './contracts.ts';
import { REFERENCE_COUNTER_ID } from './response/token-counter.ts';

export { createDefaultConfiguration, CONFIG_SCHEMA_VERSION };

/**
 * A configuration problem the operator can act on. `code` is the contract error code
 * returned to a caller; `detail` is the local explanation written to stderr and is
 * never part of the bounded search payload.
 */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
  readonly code: ErrorCode;
  readonly detail: string;

  constructor(code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

export type LoadedConfiguration = {
  /** Canonical absolute path of the trusted configuration file. */
  readonly configPath: string;
  readonly config: Configuration;
  /** Canonical absolute path of the authorized repository root. */
  readonly repositoryRoot: string;
  /** Per-user cache directory for this root and fingerprint; never inside the repository. */
  readonly cacheDirectory: string;
  /** Stable identity of the authorization-relevant configuration, used for cache namespacing. */
  readonly fingerprint: string;
};

export type LoadOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function describeErrno(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unreadable';
}

/** Canonical identity of an existing directory, with links refused rather than followed. */
function canonicalDirectory(path: string, label: string): string {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} does not exist: ${path} (${describeErrno(cause)})`);
  }
  if (stats.isSymbolicLink()) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} is a link, which v1 never follows: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} is not a directory: ${path}`);
  }
  return realpathSync.native(path);
}

/** Case-insensitive containment on Windows, exact segments elsewhere. */
export function isInsideDirectory(candidate: string, directory: string): boolean {
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  const root = fold(directory.endsWith(sep) ? directory : `${directory}${sep}`);
  return fold(candidate).startsWith(root);
}

/** Per-user base directory for local JevGrep data, outside every searched repository. */
export function userDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['JEVGREP_CACHE_HOME'];
  if (override !== undefined && override.length > 0 && isAbsolute(override)) {
    return resolve(override);
  }
  if (process.platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    return resolve(local !== undefined && local.length > 0
      ? join(local, 'jevgrep')
      : join(homedir(), 'AppData', 'Local', 'jevgrep'));
  }
  const xdg = env['XDG_CACHE_HOME'];
  return resolve(xdg !== undefined && isAbsolute(xdg) ? join(xdg, 'jevgrep') : join(homedir(), '.cache', 'jevgrep'));
}

/**
 * Fingerprint of the settings that decide what may be prepared and where it is sent.
 * Selection threshold, response budget, deadline and scan caps are deliberately
 * excluded: changing them re-runs local selection but does not invalidate a score
 * (specification section 9).
 */
export function configurationFingerprint(config: Configuration, repositoryRoot: string): string {
  return sha256Hex(JSON.stringify([
    CONFIG_SCHEMA_VERSION,
    process.platform === 'win32' ? repositoryRoot.toLowerCase() : repositoryRoot,
    config.provider.base_url.replace(/\/$/, ''),
    config.provider.model,
    config.source.respect_gitignore,
    config.source.max_file_bytes,
    [...config.source.extra_deny_globs].sort(),
  ])).slice(0, 32);
}

/**
 * Read and validate a trusted configuration file.
 *
 * The path is resolved against the process working directory, then canonicalized, so
 * the file that is validated is the file that is read.
 */
export function loadConfiguration(configPath: string, options: LoadOptions = {}): LoadedConfiguration {
  const cwd = options.cwd ?? process.cwd();
  const absolute = resolve(cwd, configPath);

  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (cause) {
    throw new ConfigurationError('INVALID_CONFIG',
      `cannot read the configuration file ${absolute} (${describeErrno(cause)})`);
  }
  if (stats.isSymbolicLink()) {
    throw new ConfigurationError('INVALID_CONFIG', `the configuration path is a link, which v1 never follows: ${absolute}`);
  }
  if (!stats.isFile()) {
    throw new ConfigurationError('INVALID_CONFIG', `the configuration path is not a regular file: ${absolute}`);
  }

  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (cause) {
    throw new ConfigurationError('INVALID_CONFIG',
      `cannot read the configuration file ${absolute} (${describeErrno(cause)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Native JSON parse messages can include source bytes from the configuration.
    throw new ConfigurationError('INVALID_CONFIG', `${absolute} is not valid JSON`);
  }

  let config: Configuration;
  try {
    config = configurationSchema.parse(parsed);
  } catch (cause) {
    if (cause instanceof ContractValidationError) {
      throw new ConfigurationError('INVALID_CONFIG', `${absolute}: ${cause.message}`);
    }
    throw cause;
  }

  const repositoryRoot = canonicalDirectory(resolve(config.repository_root), 'repository_root');
  const realConfigPath = realpathSync.native(absolute);
  if (isInsideDirectory(realConfigPath, repositoryRoot)) {
    throw new ConfigurationError('INVALID_CONFIG',
      'the trusted configuration must live outside the repository it authorizes; a repository-local file cannot grant authorization');
  }

  const fingerprint = configurationFingerprint(config, repositoryRoot);
  const cacheDirectory = join(userDataDirectory(options.env ?? process.env), 'scores', fingerprint);
  if (isInsideDirectory(cacheDirectory, repositoryRoot)) {
    throw new ConfigurationError('INVALID_CONFIG',
      `the cache directory ${cacheDirectory} would sit inside the authorized repository; set JEVGREP_CACHE_HOME elsewhere`);
  }

  return { configPath: realConfigPath, config, repositoryRoot, cacheDirectory, fingerprint };
}

/**
 * Resolve the provider secret for a real search.
 *
 * Both failures are reported before any provider work: disclosure disabled is not the
 * same problem as a missing credential, and neither is a search result.
 */
export function resolveCredential(loaded: LoadedConfiguration, env: NodeJS.ProcessEnv = process.env): string {
  if (!loaded.config.remote_evaluation_enabled) {
    throw new ConfigurationError('REMOTE_DISABLED',
      `remote evaluation is disabled in ${loaded.configPath}; set "remote_evaluation_enabled": true to send eligible excerpts to ${loaded.config.provider.base_url}`);
  }
  const name = loaded.config.provider.api_key_env;
  const secret = env[name];
  if (secret === undefined || secret.trim().length === 0) {
    throw new ConfigurationError('CREDENTIAL_MISSING',
      `the environment variable ${name} is empty or unset; export the provider credential before searching`);
  }
  return secret;
}

export type CredentialState = 'present' | 'missing' | 'not_required';

export type DoctorReport = {
  readonly config_path: string;
  readonly config_schema_version: number;
  readonly repository_root: string;
  readonly repository_root_readable: boolean;
  readonly remote_evaluation_enabled: boolean;
  readonly provider: {
    readonly base_url: string; readonly model: string;
    readonly api_key_env: string; readonly credential: CredentialState;
  };
  readonly pricing: { readonly verified_at: string; readonly input_usd_per_million_tokens: number } | null;
  readonly search: {
    readonly deadline_ms: number; readonly concurrency: number; readonly require_fit: boolean;
    readonly default_response_tokens: number; readonly max_response_tokens: number; readonly threshold: number;
  };
  readonly response_counter: string;
  readonly enabled_scan_caps: Readonly<Partial<Record<ScanCap, number>>>;
  readonly disabled_scan_caps: readonly ScanCap[];
  readonly source: {
    readonly respect_gitignore: boolean; readonly follow_links: false;
    readonly max_file_bytes: number; readonly extra_deny_globs: readonly string[];
  };
  readonly cache: {
    readonly enabled: boolean; readonly directory: string; readonly ttl_seconds: number;
    readonly max_bytes: number; readonly present: boolean;
  };
  readonly problems: readonly string[];
};

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Describe the configuration exactly as the engine will use it, with no provider call
 * and without printing the credential value.
 */
export function doctorReport(
  loaded: LoadedConfiguration,
  env: NodeJS.ProcessEnv = process.env,
  counterId = REFERENCE_COUNTER_ID,
): DoctorReport {
  const { config } = loaded;
  const secret = env[config.provider.api_key_env];
  const hasSecret = secret !== undefined && secret.trim().length > 0;
  const credential: CredentialState = !config.remote_evaluation_enabled
    ? 'not_required' : hasSecret ? 'present' : 'missing';

  const enabled: Partial<Record<ScanCap, number>> = {};
  const disabled: ScanCap[] = [];
  for (const key of SCAN_CAP_KEYS) {
    const value = config.scan_caps[key];
    if (value === null) {
      disabled.push(key);
    } else {
      enabled[key] = value;
    }
  }

  const problems: string[] = [];
  if (!config.remote_evaluation_enabled) {
    problems.push('remote evaluation is disabled: doctor and inspect work, search cannot dispatch a provider request');
  } else if (!hasSecret) {
    problems.push(`the credential environment variable ${config.provider.api_key_env} is empty or unset`);
  }
  let rootReadable = true;
  try {
    statSync(loaded.repositoryRoot);
  } catch {
    rootReadable = false;
    problems.push(`the authorized repository root ${loaded.repositoryRoot} is not readable`);
  }
  if (!config.cache.enabled) {
    problems.push('the evaluation cache is disabled: every search re-evaluates every fragment');
  }

  return {
    config_path: loaded.configPath,
    config_schema_version: config.schema_version,
    repository_root: loaded.repositoryRoot,
    repository_root_readable: rootReadable,
    remote_evaluation_enabled: config.remote_evaluation_enabled,
    provider: {
      base_url: config.provider.base_url, model: config.provider.model,
      api_key_env: config.provider.api_key_env, credential,
    },
    pricing: config.provider.pricing == null ? null : {
      verified_at: config.provider.pricing.verified_at,
      input_usd_per_million_tokens: config.provider.pricing.input_usd_per_million_tokens,
    },
    search: { ...config.search },
    response_counter: counterId,
    enabled_scan_caps: enabled,
    disabled_scan_caps: disabled,
    source: { ...config.source, extra_deny_globs: [...config.source.extra_deny_globs] },
    cache: {
      enabled: config.cache.enabled, directory: loaded.cacheDirectory,
      ttl_seconds: config.cache.ttl_seconds, max_bytes: config.cache.max_bytes,
      present: directoryExists(loaded.cacheDirectory),
    },
    problems,
  };
}

/** Human rendering for the CLI; the JSON form is the report object itself. */
export function renderDoctorReport(report: DoctorReport): string[] {
  const capLines = Object.entries(report.enabled_scan_caps).map(([key, value]) => `    ${key}: ${String(value)}`);
  const remote = report.remote_evaluation_enabled
    ? 'enabled: eligible excerpts are sent to the provider below'
    : 'disabled: no excerpt leaves this machine';
  const pricing = report.pricing === null
    ? 'none: USD estimates stay null'
    : `${report.pricing.verified_at}, $${String(report.pricing.input_usd_per_million_tokens)} per million input tokens (estimate only)`;
  const lines = [
    `configuration      ${report.config_path} (schema ${String(report.config_schema_version)})`,
    `repository root    ${report.repository_root}${report.repository_root_readable ? '' : ' (unreadable)'}`,
    `remote evaluation  ${remote}`,
    `provider           ${report.provider.base_url} model=${report.provider.model}`,
    `credential         ${report.provider.api_key_env} (${report.provider.credential}; value never printed)`,
    `pricing record     ${pricing}`,
    `response budget    default ${String(report.search.default_response_tokens)}, maximum ${String(report.search.max_response_tokens)} tokens, counter ${report.response_counter}`,
    `search limits      deadline ${String(report.search.deadline_ms)} ms, concurrency ${String(report.search.concurrency)}, threshold ${String(report.search.threshold)}, require_fit ${String(report.search.require_fit)}`,
    `scan caps          ${capLines.length === 0 ? 'all disabled (null)' : 'enabled:'}`,
    ...capLines,
    `                   disabled: ${report.disabled_scan_caps.join(', ') || 'none'}`,
    `source rules       gitignore ${String(report.source.respect_gitignore)}, links never followed, max file ${String(report.source.max_file_bytes)} bytes, ${String(report.source.extra_deny_globs.length)} operator deny rule(s)`,
    `score cache        ${report.cache.enabled ? 'enabled' : 'disabled'} ${report.cache.directory} (${report.cache.present ? 'present' : 'not created yet'}), ttl ${String(report.cache.ttl_seconds)} s, max ${String(report.cache.max_bytes)} bytes`,
  ];
  if (report.problems.length > 0) {
    lines.push('problems:');
    for (const problem of report.problems) {
      lines.push(`  - ${problem}`);
    }
  }
  return lines;
}
