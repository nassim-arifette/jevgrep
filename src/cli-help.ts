/**
 * Help text for the documented CLI surface (JG-023, specification 2.1, 4.1, 4.5 and 7.3).
 *
 * The help is generated from the same option table the parser enforces, so it can neither
 * advertise an option the parser refuses nor hide one it accepts. Each page also states what
 * the command does with the provider, and the exit-code contract it obeys.
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
  if (options.includes('--json')) {
    lines.push('outputs: stdout carries exactly the result that was asked for (canonical JSON with --json,');
    lines.push('otherwise the human view or the report); stderr carries diagnostics and measurements, so a');
  } else {
    lines.push('outputs: stdout carries exactly the requested command output or protocol; stderr carries');
    lines.push('diagnostics and measurements, so a');
  }
  lines.push('pipeline keeps the evidence even when the exit code is non-zero.');
  if (command === 'search') {
    lines.push('remote evaluation needs the credential named by the trusted configuration; without');
    lines.push('it the search is refused with exit code 2 and no request is sent.');
  } else if (command === 'mcp') {
    lines.push('starting the local stdio server performs no scan and no provider call. Tool calls may');
    lines.push('request remote evaluation only when the trusted configuration allows it and a credential exists.');
  } else {
    lines.push('this command is local: it never needs a credential and never contacts the provider.');
  }
  lines.push('');
  lines.push('exit codes: 0 complete, 2 rejected request or configuration, 3 partial result,');
  lines.push('4 fatal runtime failure, 130 interrupted. See docs/specification.md sections 2.1,');
  lines.push('4.1, 4.5 and 7.3.');
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
    'Commands validate their arguments, then run against the shared engine. Search requests',
    '(from the CLI or an MCP tool call) may contact the configured remote provider only when',
    'the trusted configuration allows it and the credential is present.',
    '',
    'options:',
    '  -h, --help      show this help and exit 0',
    '  -V, --version   show the package version and exit 0',
    '',
    'commands:',
  ];
  for (const command of documentedCommands()) {
    lines.push(`  ${command}`);
  }
  lines.push('');
  lines.push("run 'jevgrep <command> --help' for the options of one command");
  lines.push('');
  lines.push('exit codes:');
  lines.push('  0    complete result');
  lines.push('  2    rejected request, configuration or credential');
  lines.push('  3    partial result: the scan or the response is incomplete, and the report says so');
  lines.push('  4    fatal runtime failure, for example an unreadable package manifest');
  lines.push('  130  user interruption');
  lines.push('');
  lines.push('documentation: README.md, docs/specification.md, docs/issues.md');
  return lines.join('\n');
}
