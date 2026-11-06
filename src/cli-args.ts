/**
 * Command-line argument surface (JG-023).
 *
 * This module owns argv parsing only: command dispatch, option arity, the documented flags
 * and the request limits. It performs no I/O beyond the injected query-file reader, reads no
 * configuration, touches no repository and calls no provider, so the CLI cannot drift from
 * the shared contract: the search request is validated by src/contracts.ts, which MCP uses
 * as well.
 *
 * Exit code ownership stays with src/cli.ts (specification 4.5).
 */
import { CONTRACT_LIMITS, parseSearchRequest, type SearchRequest } from './contracts.ts';

/** Commands of the documented CLI surface (specification 4.5). */
export type CliCommand =
  | { readonly kind: 'init'; readonly root: string; readonly provider?: 'typesafe' | 'vercel' | 'openrouter'; readonly global: boolean }
  | {
    readonly kind: 'search'; readonly config?: string; readonly request: SearchRequest; readonly json: boolean;
    /** Further questions over the same scope and options, from a repeated --query. */
    readonly moreRequests?: readonly SearchRequest[];
  }
  | { readonly kind: 'inspect'; readonly config?: string; readonly scope: readonly string[]; readonly json: boolean }
  | { readonly kind: 'doctor'; readonly config?: string }
  | { readonly kind: 'mcp'; readonly config?: string }
  | { readonly kind: 'cache-clear'; readonly config?: string };

export type CliParseResult =
  | { readonly kind: 'command'; readonly command: CliCommand }
  | { readonly kind: 'error'; readonly message: string };

/** Injected side effect: the CLI reads a query file, parsing itself stays pure. */
export type CliParseDependencies = {
  readonly readFile: (path: string) => string;
};

type OptionState = {
  readonly config: string | undefined;
  readonly query: string | undefined;
  readonly queryFile: string | undefined;
  readonly scope: readonly string[];
  readonly maxContextTokens: string | undefined;
  readonly continuation: string | undefined;
  readonly budget: { maxInputTokens?: number; maxCostUsd?: number; maxSearchMs?: number };
  readonly moreQueries: readonly string[];
  readonly allowPartial: boolean;
  readonly json: boolean;
  readonly root: string | undefined;
  readonly provider: string | undefined;
  readonly global: boolean;
};

/** Options each command accepts, so a misplaced flag is refused instead of ignored. */
const ALLOWED_OPTIONS: Record<string, readonly string[]> = {
  init: ['--root', '--provider', '--global'],
  search: ['--config', '--query', '--query-file', '--scope', '--max-context-tokens', '--allow-partial', '--continuation', '--json',
    '--max-input-tokens', '--max-cost-usd', '--max-search-ms'],
  inspect: ['--config', '--scope', '--json'],
  doctor: ['--config'],
  mcp: ['--config'],
  'cache clear': ['--config'],
};

const COMMANDS: readonly string[] = ['init', 'search', 'inspect', 'doctor', 'mcp', 'cache'];

/**
 * Early refusal of a scope entry the contract would reject later.
 *
 * The search path delegates the whole request to src/contracts.ts, which owns these rules.
 * `inspect` has no request object of its own, so the same documented limits
 * (specification 4.1: no absolute path, no traversal, no control character; at most 32
 * entries and 4,096 UTF-8 bytes in total) are applied here to refuse it before any file is
 * opened. Consolidate this with the contracts module as soon as it exposes a scope
 * validator; the shape of the refusal is the CLI's, the rule is the specification's.
 */
function scopeEntryError(value: string): string | undefined {
  if (value.trim().length === 0) {
    return "'--scope' needs a non-empty relative path";
  }
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) {
    return `scope '${value}' must be a relative path inside the authorized repository`;
  }
  // oxlint-disable-next-line no-control-regex -- control characters are rejected on purpose
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return `scope '${value}' contains a control character`;
  }
  if (value.replaceAll('\\', '/').split('/').includes('..')) {
    return `scope '${value}' must not traverse outside the authorized repository`;
  }
  return undefined;
}

function scopeError(scope: readonly string[]): string | undefined {
  if (scope.length > CONTRACT_LIMITS.scope_entries) {
    return `at most ${String(CONTRACT_LIMITS.scope_entries)} scope entries are accepted`;
  }
  const bytes = scope.reduce((total, entry) => total + Buffer.byteLength(entry, 'utf8'), 0);
  if (bytes > CONTRACT_LIMITS.scope_bytes) {
    return `the scope exceeds ${String(CONTRACT_LIMITS.scope_bytes)} UTF-8 bytes`;
  }
  for (const entry of scope) {
    const refusal = scopeEntryError(entry);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}

/** Options a command accepts, in the order the help should document them. */
export function allowedOptionsFor(command: string): readonly string[] | undefined {
  return ALLOWED_OPTIONS[command];
}

function refuse(message: string): CliParseResult {
  return { kind: 'error', message };
}

function readOptions(
  argv: readonly string[],
  allowed: readonly string[],
): { readonly state: OptionState; readonly error: string | undefined } {
  const mutable: MutableOptions = { config: undefined, query: undefined, queryFile: undefined, scope: [], maxContextTokens: undefined, continuation: undefined, budget: {}, moreQueries: [], allowPartial: false, json: false, root: undefined, provider: undefined, global: false };
  const state = mutable;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) {
      break;
    }
    if (!option.startsWith('--')) {
      return { state, error: `unexpected argument '${option}'` };
    }
    if (!allowed.includes(option)) {
      return { state, error: `option '${option}' is not accepted here` };
    }
    if (option === '--allow-partial') {
      state.allowPartial = true;
      continue;
    }
    if (option === '--json') {
      state.json = true;
      continue;
    }
    if (option === '--global') {
      state.global = true;
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined) {
      return { state, error: `option '${option}' needs a value` };
    }
    index += 1;

    const error = applyValueOption(state, option, value);
    if (error !== undefined) return { state, error };
  }

  return { state, error: undefined };
}

type MutableOptions = {
  config: string | undefined;
  query: string | undefined;
  queryFile: string | undefined;
  scope: string[];
  maxContextTokens: string | undefined;
  continuation: string | undefined;
  budget: { maxInputTokens?: number; maxCostUsd?: number; maxSearchMs?: number };
  moreQueries: string[];
  allowPartial: boolean;
  json: boolean;
  root: string | undefined;
  provider: string | undefined;
  global: boolean;
};

/** Questions one search command accepts through repeated --query options. */
export const MAX_QUESTIONS = 8;

/** Store one option that takes a value, or explain why it is refused. */
function applyValueOption(state: MutableOptions, option: string, value: string): string | undefined {
  switch (option) {
    case '--continuation':
      if (state.continuation !== undefined) return "option '--continuation' was given twice";
      state.continuation = value;
      return undefined;
    case '--root':
      if (state.root !== undefined) return "option '--root' was given twice";
      state.root = value;
      return undefined;
    case '--provider':
      if (state.provider !== undefined) return "option '--provider' was given twice";
      if (value !== 'typesafe' && value !== 'vercel' && value !== 'openrouter') return "option '--provider' must be 'typesafe', 'vercel' or 'openrouter'";
      state.provider = value;
      return undefined;
    case '--config':
      if (state.config !== undefined) {
        return "option '--config' was given twice";
      }
      if (value.trim().length === 0) {
        return "option '--config' needs a non-empty path";
      }
      state.config = value;
      return undefined;
    case '--query':
      if (state.query !== undefined) {
        if (state.moreQueries.length + 1 >= MAX_QUESTIONS) return `at most ${String(MAX_QUESTIONS)} '--query' options are accepted`;
        state.moreQueries.push(value);
        return undefined;
      }
      state.query = value;
      return undefined;
    case '--query-file':
      if (state.queryFile !== undefined) {
        return "option '--query-file' was given twice";
      }
      state.queryFile = value;
      return undefined;
    case '--scope':
      if (value.trim().length === 0) {
        return "option '--scope' needs a non-empty path";
      }
      state.scope.push(value);
      return undefined;
    case '--max-context-tokens':
      if (state.maxContextTokens !== undefined) {
        return "option '--max-context-tokens' was given twice";
      }
      if (!/^[0-9]+$/.test(value)) {
        return `option '--max-context-tokens' needs a positive integer, got '${value}'`;
      }
      state.maxContextTokens = value;
      return undefined;
    case '--max-input-tokens':
    case '--max-search-ms': {
      const key = option === '--max-input-tokens' ? 'maxInputTokens' : 'maxSearchMs';
      if (state.budget[key] !== undefined) return `option '${option}' was given twice`;
      if (!/^[1-9][0-9]*$/.test(value)) return `option '${option}' needs a positive integer, got '${value}'`;
      state.budget[key] = Number(value);
      return undefined;
    }
    case '--max-cost-usd':
      if (state.budget.maxCostUsd !== undefined) return "option '--max-cost-usd' was given twice";
      if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) return `option '--max-cost-usd' needs a non-negative number, got '${value}'`;
      state.budget.maxCostUsd = Number(value);
      return undefined;
    default:
      return `option '${option}' is not accepted here`;
  }
}

function searchCommand(
  state: OptionState,
  scope: readonly string[],
  config: string | undefined,
  dependencies: CliParseDependencies,
): CliParseResult {
  const query = state.query;
  const queryFile = state.queryFile;
  if (query !== undefined && queryFile !== undefined) {
    return refuse("use either '--query' or '--query-file', not both");
  }
  if (query === undefined && queryFile === undefined) {
    return refuse("option '--query' or '--query-file' is required");
  }
  let text: string;
  if (queryFile !== undefined) {
    try {
      text = dependencies.readFile(queryFile);
    } catch (readError) {
      return refuse(`cannot read the query file '${queryFile}': ${messageOf(readError)}`);
    }
  } else {
    text = query ?? '';
  }

  const raw: Record<string, unknown> = {
    query: text,
    scope,
    allow_partial_scan: state.allowPartial,
    ...(state.continuation === undefined ? {} : { continuation: state.continuation }),
  };
  if (state.maxContextTokens !== undefined) {
    raw['max_context_tokens'] = Number(state.maxContextTokens);
  }
  if (state.budget.maxInputTokens !== undefined) raw['max_input_tokens'] = state.budget.maxInputTokens;
  if (state.budget.maxCostUsd !== undefined) raw['max_cost_usd'] = state.budget.maxCostUsd;
  if (state.budget.maxSearchMs !== undefined) raw['max_search_ms'] = state.budget.maxSearchMs;
  try {
    // The engine applies operator limits after loading trusted configuration.
    const { max_context_tokens, ...normalized } = parseSearchRequest(raw, {
      default_response_tokens: CONTRACT_LIMITS.default_response_tokens, max_response_tokens: Number.MAX_SAFE_INTEGER,
    });
    const request: SearchRequest = { ...normalized, ...(state.maxContextTokens === undefined ? {} : { max_context_tokens }) };
    if (state.moreQueries.length > 0 && state.continuation !== undefined) {
      return refuse("'--continuation' continues one question; give a single '--query'");
    }
    const moreRequests = state.moreQueries.map((more) => ({ ...request, query: parseSearchRequest({ ...raw, query: more }, {
      default_response_tokens: CONTRACT_LIMITS.default_response_tokens, max_response_tokens: Number.MAX_SAFE_INTEGER,
    }).query }));
    return { kind: 'command', command: {
      kind: 'search', ...(config === undefined ? {} : { config }), request, json: state.json,
      ...(moreRequests.length === 0 ? {} : { moreRequests }),
    } };
  } catch (validationError) {
    return refuse(messageOf(validationError));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse argv (without the executable and script name) into one command, or explain why the
 * input is refused. Never throws for user input.
 */
export function parseCliArguments(
  argv: readonly string[],
  dependencies: CliParseDependencies,
): CliParseResult {
  const command = argv[0];
  if (command === undefined) {
    return refuse('no command given');
  }
  if (!COMMANDS.includes(command)) {
    return refuse(`unknown command '${command}'`);
  }

  let subcommand: string | undefined;
  let optionStart = 1;
  if (command === 'cache') {
    subcommand = argv[1];
    if (subcommand === undefined) {
      return refuse("command 'cache' needs a subcommand: 'cache clear --config <path>'");
    }
    if (subcommand !== 'clear') {
      return refuse(`unknown subcommand '${subcommand}' for 'cache'; only 'cache clear' exists`);
    }
    optionStart = 2;
  }

  const key = subcommand === undefined ? command : `${command} ${subcommand}`;
  const allowed = ALLOWED_OPTIONS[key];
  if (allowed === undefined) {
    return refuse(`command '${key}' is not part of the documented surface`);
  }

  const { state, error } = readOptions(argv.slice(optionStart), allowed);
  if (error !== undefined) {
    return refuse(error);
  }
  if (command === 'init') {
    if (state.global && state.root !== undefined) return refuse("option '--root' cannot be used with '--global'");
    return { kind: 'command', command: {
      kind: 'init', root: state.root ?? '.',
      global: state.global,
      ...(state.provider === undefined ? {} : { provider: state.provider as 'typesafe' | 'vercel' | 'openrouter' }),
    } };
  }
  const config = state.config;
  const scope = state.scope.length > 0 ? state.scope : ['.'];

  if (command === 'search') return searchCommand(state, scope, config, dependencies);

  if (command === 'inspect') {
    const refusal = scopeError(scope);
    if (refusal !== undefined) {
      return refuse(refusal);
    }
    return { kind: 'command', command: { kind: 'inspect', ...(config === undefined ? {} : { config }), scope, json: state.json } };
  }
  if (command === 'doctor') {
    return { kind: 'command', command: { kind: 'doctor', ...(config === undefined ? {} : { config }) } };
  }
  if (command === 'mcp') {
    return { kind: 'command', command: { kind: 'mcp', ...(config === undefined ? {} : { config }) } };
  }
  return { kind: 'command', command: { kind: 'cache-clear', ...(config === undefined ? {} : { config }) } };
}
