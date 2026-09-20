#!/usr/bin/env node
/**
 * JevGrep command-line entry point.
 *
 * The entry point validates arguments, handles help/version, and dispatches every
 * documented command to the shared command layer. Provider activation remains guarded
 * by trusted repository authorization, explicit remote enablement and credentials.
 */
import { readFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseCliArguments, type CliCommand } from './cli-args.ts';
import { executeCommand } from './cli-commands.ts';
import { commandHelp, documentedCommands, globalHelp } from './cli-help.ts';
import { CLI_EXIT_CODES } from './search-response.ts';

/** Complete result from the product contract (section 4.5). */
export const EXIT_OK = CLI_EXIT_CODES.complete;
/** Invalid request, unknown command or bad arguments (product contract section 4.5). */
export const EXIT_USAGE = CLI_EXIT_CODES.rejected;
/** Fatal runtime failure, for example an unreadable or malformed package manifest. */
export const EXIT_FATAL = CLI_EXIT_CODES.error;
/** Integer exit codes the process adapter may propagate from the command layer. */
const EXIT_CODES_IN_USE: ReadonlySet<number> = new Set([
  EXIT_OK,
  EXIT_USAGE,
  EXIT_FATAL,
  CLI_EXIT_CODES.partial,
  CLI_EXIT_CODES.interrupted,
]);

/** Minimal output seam: tests capture the CLI without spawning a child process. */
export type CliIo = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** Replaceable collaborators, so tests can force the failure paths. */
export type CliDependencies = {
  readonly readVersion: () => string;
  /**
   * Dispatch a command whose arguments were validated. The default runner is the shared
   * command layer (`cli-commands.ts`); a test injects its own to drive one command without a
   * workspace or a provider.
   */
  readonly runCommand?: (command: CliCommand) => Promise<number>;
};

const defaultDependencies: CliDependencies = {
  readVersion: () => readPackageVersion(),
};

/**
 * The process adapter: one interruption signal shared by the dispatched command, wired to
 * SIGINT and SIGTERM so a cancelled run reports the documented interrupted code instead of
 * dying silently.
 */
function interruptionSignal(): AbortSignal {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      controller.abort();
    });
  }
  return controller.signal;
}

/** Add one line ending without duplicating one already included in a measured payload. */
export function stdoutLine(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

const defaultIo: CliIo = {
  out: (line: string): void => {
    process.stdout.write(stdoutLine(line));
  },
  err: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
};

/** First word of every documented command, used to tell a command from a typo. */
const COMMAND_WORDS: ReadonlySet<string> = new Set(
  documentedCommands().map((command) => command.split(' ')[0] ?? command),
);


/** Canonical global help text; the CLI prints it and tests assert its content. */
export function helpText(): string {
  return globalHelp();
}

/**
 * Read the package version from the manifest that owns this module. The lookup is
 * relative to the module, never to the current working directory, so the CLI reports
 * the same version from any directory.
 */
export function readPackageVersion(moduleUrl: string = import.meta.url): string {
  const manifestPath = fileURLToPath(new URL('../package.json', moduleUrl));
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const candidate = manifest as { version?: unknown };
  if (typeof candidate.version !== 'string') {
    throw new Error(`no "version" field in ${manifestPath}`);
  }
  return candidate.version;
}

/** True when this module is the process entry point (works on Node 24 without import.meta.main). */
export function isMainModule(moduleUrl: string = import.meta.url): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/**
 * Validate the arguments of a documented command, then run it.
 *
 * Validation happens before any work: a caller gets exit 2 with a usable message instead of
 * discovering a typo after a scan started. `--help` is answered here too, from the same
 * option table the parser enforces, so the help cannot promise an option that would be
 * refused. Once validated, the command goes to the shared command layer and its exit code is
 * propagated unchanged.
 */
/** Help topic named by argv: the documented command, with `cache clear` as one topic. */
function helpTopic(argv: readonly string[]): string {
  const first = argv[0] ?? '';
  return first === 'cache' ? 'cache clear' : first;
}

/** A short, upper-case error code is safe to show; a message or a path is not. */
function safeCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(code) ? code : undefined;
}

async function dispatchCommand(
  io: CliIo,
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  // `--help` after a command prints that command's page: the option table is the one the
  // parser enforces, so the help cannot promise an option that would be refused.
  if (argv.includes('--help') || argv.includes('-h')) {
    const help = commandHelp(helpTopic(argv));
    if (help === undefined) {
      return usageError(io, `unknown command '${String(argv[0])}'`);
    }
    io.out(help);
    return EXIT_OK;
  }

  const parsed = parseCliArguments(argv, {
    readFile: (path: string): string => readFileSync(path, 'utf8'),
  });
  if (parsed.kind === 'error') {
    return usageError(io, parsed.message);
  }
  const command: CliCommand = parsed.command;
  // The command layer is the only implementation; the injectable runner exists so a test can
  // drive one command without a workspace or a provider.
  const runner =
    dependencies.runCommand ??
    ((dispatched: CliCommand): Promise<number> =>
      executeCommand(dispatched, io, { signal: interruptionSignal() }));

  try {
    const code = await runner(command);
    if (!Number.isInteger(code) || !EXIT_CODES_IN_USE.has(code)) {
      io.err('jevgrep: command failed; no result was produced');
      return EXIT_FATAL;
    }
    return code;
  } catch (error) {
    const code = safeCodeOf(error);
    const detail = code === undefined ? '' : ` (${code})`;
    io.err(`jevgrep: command failed${detail}; no result was produced`);
    return EXIT_FATAL;
  }
}

function usageError(io: CliIo, detail: string): number {
  io.err(`jevgrep: ${detail}`);
  io.err("run 'jevgrep --help' for usage");
  return EXIT_USAGE;
}

/**
 * Report the version, or a single diagnostic line when the installed manifest cannot be
 * read. The message stays free of stack traces: the failure mode is a broken
 * installation, and a caller must be able to see that from the exit code alone.
 */
function reportVersion(io: CliIo, dependencies: CliDependencies): number {
  try {
    io.out(`jevgrep ${dependencies.readVersion()}`);
    return EXIT_OK;
  } catch {
    io.err('jevgrep: cannot read the package manifest of this installation; reinstall the package');
    return EXIT_FATAL;
  }
}

/**
 * Run one CLI invocation. Returns the process exit code and never throws for user
 * input: invalid input is reported on stderr with a non-zero code.
 */
export async function main(
  argv: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  const first = argv[0];
  const rest = argv.slice(1);

  if (first === undefined) {
    return usageError(io, 'no command given');
  }
  if (first === '-h' || first === '--help') {
    if (rest.length > 0) {
      return usageError(io, `unexpected argument '${String(rest[0])}' after '${first}'`);
    }
    io.out(helpText());
    return EXIT_OK;
  }
  if (first === '-V' || first === '--version') {
    if (rest.length > 0) {
      return usageError(io, `unexpected argument '${String(rest[0])}' after '${first}'`);
    }
    return reportVersion(io, dependencies);
  }
  if (first.startsWith('-')) {
    return usageError(io, `unknown option '${first}'`);
  }

  if (COMMAND_WORDS.has(first)) {
    return await dispatchCommand(io, argv, dependencies);
  }
  return usageError(io, `unknown command '${first}'`);
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
