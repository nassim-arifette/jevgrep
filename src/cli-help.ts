/**
 * Help text for the documented CLI surface (JG-023, specification 2.1, 4.1, 4.5 and 7.3).
 *
 * The help is generated from the same option table the parser enforces, so it can neither
 * advertise an option the parser refuses nor hide one it accepts. Nothing here claims a
 * command runs: every page says what is not implemented yet, because the engine arrives
 * with JG-014 and JG-022.
 */
import { allowedOptionsFor } from './cli-args.ts';

const COMMAND_SUMMARY: Record<string, string> = {
  doctor: 'Validate the trusted configuration and report the local setup without any network call.',
  inspect: 'Report the eligible scope, exclusions and estimated work without contacting the provider.',
  search: 'Return original excerpts that answer a behavior question, inside the response budget.',
  mcp: 'Serve semantic_search_code over the MCP stdio transport (one root per process).',
  'cache clear': 'Delete the local score cache directory.',
};

const OPTION_TEXT: Record<string, string> = {
  '--config': '--config <path>            trusted configuration file (required, never read from the repository)',
  '--query': '--query <text>             the search question, kept verbatim',
  '--query-file': '--query-file <path>        read the question from a file (multiline queries)',
  '--scope': '--scope <relative path>    repeatable, default ".", never absolute and never traversing',
  '--max-context-tokens': '--max-context-tokens <n>   response budget in reference tokens (default 4000, min 1024, max 16000)',
  '--allow-partial': '--allow-partial            allow a partial scan explicitly (default: refuse)',
  '--json': '--json                     canonical JSON on stdout instead of the human view',
};

/** Usage line of each command, written by hand so a choice is shown as a choice. */
const COMMAND_USAGE: Record<string, string> = {
  search:
    'jevgrep search --config <path> (--query <text> | --query-file <path>) [--scope <path>]... [--max-context-tokens <n>] [--json] [--allow-partial]',
  inspect: 'jevgrep inspect --config <path> [--scope <path>]... [--json]',
  doctor: 'jevgrep doctor --config <path>',
  mcp: 'jevgrep mcp --config <path>',
  'cache clear': 'jevgrep cache clear --config <path>',
};

/** The commands this build documents, in the order the global help lists them. */
export function documentedCommands(): readonly string[] {
  return ['search', 'inspect', 'doctor', 'mcp', 'cache clear'];
}

/** Help page of one command, or undefined when the command is not documented. */
export function commandHelp(command: string): string | undefined {
  if (!documentedCommands().includes(command)) {
    return undefined;
  }
  const options = allowedOptionsFor(command) ?? [];
  const lines: string[] = [
    `usage: ${COMMAND_USAGE[command] ?? `jevgrep ${command} --config <path>`}`,
    '',
    COMMAND_SUMMARY[command] ?? '',
    '',
    'options:',
  ];
  for (const option of options) {
    const text = OPTION_TEXT[option];
    if (text !== undefined) {
      lines.push(`  ${text}`);
    }
  }
  lines.push('  -h, --help                 show this page and exit 0');
  lines.push('');
  lines.push(`not implemented in this build: '${command}' validates its arguments and then exits 69`);
  lines.push('without touching a repository, a provider or the cache. The behaviour above is the');
  lines.push('contract of docs/specification.md (sections 2.1, 4.1, 4.5 and 7.3), implemented with');
  lines.push('JG-014 for the first CLI path and JG-022/JG-023 for the final commands.');
  return lines.join('\n');
}

/** Global help: options of the executable plus the documented commands. */
export function globalHelp(): string {
  const lines: string[] = [
    'usage: jevgrep --help | --version | <command> [options]',
    '',
    "JevGrep finds evidence in a repository for a coding agent's question. It evaluates",
    'authorized code fragments with a configured remote Jev provider and returns original',
    'excerpts under a response budget.',
    '',
    'This build is the development scaffold: argument validation, offline checks and the corpus',
    'exist, and no search command runs yet. Every command below validates its arguments, then',
    'exits 69 without performing any work, so nothing unimplemented is presented as available.',
    '',
    'options:',
    '  -h, --help      show this help and exit 0',
    '  -V, --version   show the package version and exit 0',
    '',
    'documented commands, not implemented in this build (each one exits 69 and performs no work):',
  ];
  for (const command of documentedCommands()) {
    lines.push(`  ${command}`);
  }
  lines.push('');
  lines.push("run 'jevgrep <command> --help' for the options of one command");
  lines.push('');
  lines.push('exit codes:');
  lines.push('  0    complete result');
  lines.push('  2    invalid request, unknown command or bad arguments');
  lines.push('  4    fatal runtime failure, for example an unreadable package manifest');
  lines.push('  69   command planned but not implemented in this build');
  lines.push('  3    partial result (reserved: arrives with the first search command)');
  lines.push('  130  user interruption (reserved)');
  lines.push('');
  lines.push('documentation: README.md, docs/specification.md, docs/issues.md');
  return lines.join('\n');
}
