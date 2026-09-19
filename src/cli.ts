#!/usr/bin/env node
/**
 * JevGrep command-line entry point.
 *
 * JG-001 creates the package scaffold: a strict TypeScript package, an executable
 * entry point and offline checks. No search command exists yet, so this file
 * implements `--help` and `--version` only and rejects every other command instead
 * of pretending it works. Planned commands and the eventual exit-code contract are
 * in docs/specification.md (section 4.5) and docs/issues.md.
 */
import { readFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Complete result from the product contract (section 4.5). */
export const EXIT_OK = 0;
/** Invalid request, unknown command or bad arguments (product contract section 4.5). */
export const EXIT_USAGE = 2;
/** Fatal runtime failure, for example an unreadable or malformed package manifest. */
export const EXIT_FATAL = 4;
/**
 * Scaffold-only code: the command exists in the product contract but not in this
 * build. It is deliberately outside the reserved set {0, 2, 3, 4, 130} so a caller
 * can never mistake it for a complete, partial or failed search. It disappears when
 * JG-014, JG-007, JG-018 and JG-024 implement those commands.
 */
export const EXIT_NOT_IMPLEMENTED = 69;

/** Minimal output seam: tests capture the CLI without spawning a child process. */
export type CliIo = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** Replaceable collaborators, so tests can force the failure paths. */
export type CliDependencies = {
  readonly readVersion: () => string;
};

const defaultDependencies: CliDependencies = {
  readVersion: () => readPackageVersion(),
};

const defaultIo: CliIo = {
  out: (line: string): void => {
    process.stdout.write(`${line}\n`);
  },
  err: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
};

/** Commands promised by the specification, with the issue that will implement each one. */
const PLANNED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['search', 'JG-014'],
  ['inspect', 'JG-014'],
  ['doctor', 'JG-007'],
  ['mcp', 'JG-024'],
  ['cache', 'JG-018'],
]);

const HELP_LINES: readonly string[] = [
  'usage: jevgrep --help | --version',
  '',
  "JevGrep finds evidence in a repository for a coding agent's question. It evaluates",
  'authorized code fragments with a configured remote Jev provider and returns original',
  'excerpts under a response budget.',
  '',
  'This build is the JG-001 development scaffold. It implements no repository-analysis command:',
  'running it performs no work, reads no repository and contacts no provider.',
  '',
  'options:',
  '  -h, --help      show this help and exit 0',
  '  -V, --version   show the package version and exit 0',
  '',
  'planned commands, not implemented in this build (each one exits 69 and performs no work):',
  '  cache clear --config <path>',
  '  doctor --config <path>',
  '  inspect --config <path> [--scope <path>]... [--json]',
  '  mcp --config <path>',
  '  search --config <path> --query <text> [--scope <path>]... [--max-context-tokens <n>] [--json] [--allow-partial]',
  '',
  'exit codes:',
  '  0    complete result',
  '  2    invalid request, unknown command or bad arguments',
  '  4    fatal runtime failure, for example an unreadable package manifest',
  '  69   command planned but not implemented in this build',
  '  3    partial result (reserved: arrives with the first search command)',
  '  130  user interruption (reserved)',
  '',
  'documentation: README.md, docs/specification.md, docs/issues.md',
];

/** Canonical help text; the CLI prints it and tests assert its content. */
export function helpText(): string {
  return HELP_LINES.join('\n');
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

  const implementingIssue = PLANNED_COMMANDS.get(first);
  if (implementingIssue !== undefined) {
    io.err(`jevgrep: '${first}' is planned (${implementingIssue}) but not implemented in this build; no work was performed`);
    return EXIT_NOT_IMPLEMENTED;
  }
  return usageError(io, `unknown command '${first}'`);
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
