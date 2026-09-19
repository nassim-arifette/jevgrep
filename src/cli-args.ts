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
import { CONTRACT_LIMITS, parseSearchRequest, type ResolvedSearchRequest } from './contracts.ts';

/** Commands of the documented CLI surface (specification 4.5). */
export type CliCommand =
  | { readonly kind: 'search'; readonly config: string; readonly request: ResolvedSearchRequest; readonly json: boolean }
  | { readonly kind: 'inspect'; readonly config: string; readonly scope: readonly string[]; readonly json: boolean }
  | { readonly kind: 'doctor'; readonly config: string }
  | { readonly kind: 'mcp'; readonly config: string }
  | { readonly kind: 'cache-clear'; readonly config: string };

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
  readonly allowPartial: boolean;
  readonly json: boolean;
};

/** Options each command accepts, so a misplaced flag is refused instead of ignored. */
const ALLOWED_OPTIONS: Record<string, readonly string[]> = {
  search: ['--config', '--query', '--query-file', '--scope', '--max-context-tokens', '--allow-partial', '--json'],
  inspect: ['--config', '--scope', '--json'],
  doctor: ['--config'],
  mcp: ['--config'],
  'cache clear': ['--config'],
};

const COMMANDS: readonly string[] = ['search', 'inspect', 'doctor', 'mcp', 'cache'];

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

function refuse(message: string): CliParseResult {
  return { kind: 'error', message };
}

function readOptions(
  argv: readonly string[],
  allowed: readonly string[],
): { readonly state: OptionState; readonly error: string | undefined } {
  const mutable: {
    config: string | undefined;
    query: string | undefined;
    queryFile: string | undefined;
    scope: string[];
    maxContextTokens: string | undefined;
    allowPartial: boolean;
    json: boolean;
  } = { config: undefined, query: undefined, queryFile: undefined, scope: [], maxContextTokens: undefined, allowPartial: false, json: false };
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

    const value = argv[index + 1];
    if (value === undefined) {
      return { state, error: `option '${option}' needs a value` };
    }
    index += 1;

    switch (option) {
      case '--config':
        if (state.config !== undefined) {
          return { state, error: "option '--config' was given twice" };
        }
        if (value.trim().length === 0) {
          return { state, error: "option '--config' needs a non-empty path" };
        }
        state.config = value;
        break;
      case '--query':
        if (state.query !== undefined) {
          return { state, error: "option '--query' was given twice; use --query-file for a long query" };
        }
        state.query = value;
        break;
      case '--query-file':
        if (state.queryFile !== undefined) {
          return { state, error: "option '--query-file' was given twice" };
        }
        state.queryFile = value;
        break;
      case '--scope':
        if (value.trim().length === 0) {
          return { state, error: "option '--scope' needs a non-empty path" };
        }
        state.scope.push(value);
        break;
      case '--max-context-tokens':
        if (state.maxContextTokens !== undefined) {
          return { state, error: "option '--max-context-tokens' was given twice" };
        }
        if (!/^[0-9]+$/.test(value)) {
          return { state, error: `option '--max-context-tokens' needs a positive integer, got '${value}'` };
        }
        state.maxContextTokens = value;
        break;
      default:
        return { state, error: `option '${option}' is not accepted here` };
    }
  }

  return { state, error: undefined };
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
  const config = state.config;
  if (config === undefined) {
    return refuse("option '--config' is required: the trusted configuration names the authorized repository");
  }
  const scope = state.scope.length > 0 ? state.scope : ['.'];

  if (command === 'search') {
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
    };
    if (state.maxContextTokens !== undefined) {
      raw['max_context_tokens'] = Number(state.maxContextTokens);
    }
    try {
      const request = parseSearchRequest(raw);
      return { kind: 'command', command: { kind: 'search', config, request, json: state.json } };
    } catch (validationError) {
      return refuse(messageOf(validationError));
    }
  }

  if (command === 'inspect') {
    const refusal = scopeError(scope);
    if (refusal !== undefined) {
      return refuse(refusal);
    }
    return { kind: 'command', command: { kind: 'inspect', config, scope, json: state.json } };
  }
  if (command === 'doctor') {
    return { kind: 'command', command: { kind: 'doctor', config } };
  }
  if (command === 'mcp') {
    return { kind: 'command', command: { kind: 'mcp', config } };
  }
  return { kind: 'command', command: { kind: 'cache-clear', config } };
}
