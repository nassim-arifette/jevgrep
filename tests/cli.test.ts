import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EXIT_FATAL,
  EXIT_NOT_IMPLEMENTED,
  EXIT_OK,
  EXIT_USAGE,
  helpText,
  main,
  readPackageVersion,
} from '../src/cli.ts';
import type { CliDependencies, CliIo } from '../src/cli.ts';
import { repoRoot } from './helpers/cli-runner.ts';

type Capture = {
  readonly io: CliIo;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
};

function capture(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      out: (line: string): void => {
        stdout.push(line);
      },
      err: (line: string): void => {
        stderr.push(line);
      },
    },
    stdout,
    stderr,
  };
}

async function invoke(
  argv: readonly string[],
  dependencies?: CliDependencies,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const captured = capture();
  const code = dependencies === undefined ? await main(argv, captured.io) : await main(argv, captured.io, dependencies);
  return { code, stdout: captured.stdout.join('\n'), stderr: captured.stderr.join('\n') };
}

test('--help prints the help text on stdout and succeeds', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await invoke([flag]);
    assert.equal(result.code, EXIT_OK);
    assert.equal(result.stdout, helpText());
    assert.equal(result.stderr, '');
  }
});

test('--version prints the manifest version and succeeds', async () => {
  const manifest: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const expected = (manifest as { version: string }).version;

  for (const flag of ['--version', '-V']) {
    const result = await invoke([flag]);
    assert.equal(result.code, EXIT_OK);
    assert.equal(result.stdout, `jevgrep ${expected}`);
    assert.equal(result.stderr, '');
  }
});

test('--version reports a fatal code instead of a stack trace when the manifest is unreadable', async () => {
  const result = await invoke(['--version'], {
    readVersion: (): string => {
      throw new Error('ENOENT: no such file or directory, open C:/broken/package.json');
    },
  });

  assert.equal(result.code, EXIT_FATAL);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /cannot read the package manifest/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'no stack trace may reach the caller');
  assert.doesNotMatch(result.stderr, /broken\/package\.json|C:\/broken/, 'no absolute path may reach the caller');
});

test('the version lookup does not depend on the entry point location', () => {
  const fromRepo = readPackageVersion();
  assert.equal(fromRepo, readPackageVersion(new URL('../src/cli.ts', import.meta.url).href));
  assert.match(fromRepo, /^\d+\.\d+\.\d+$/);
});

test('no arguments is a usage error', async () => {
  const result = await invoke([]);
  assert.equal(result.code, EXIT_USAGE);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no command given/);
  assert.match(result.stderr, /--help/);
});

test('an unknown command is a usage error, not a silent success', async () => {
  const result = await invoke(['seach']);
  assert.equal(result.code, EXIT_USAGE);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown command 'seach'/);
});

test('an unknown option is a usage error', async () => {
  const result = await invoke(['--verbose']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr, /unknown option '--verbose'/);
});

test('extra arguments after --help or --version are rejected', async () => {
  for (const argv of [['--help', 'extra'], ['--version', 'extra']]) {
    const result = await invoke(argv);
    assert.equal(result.code, EXIT_USAGE);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unexpected argument 'extra'/);
  }
});

test('planned but unimplemented commands exit non-zero and claim no work', async () => {
  const planned: readonly (readonly string[])[] = [
    ['search', '--config', 'config.json', '--query', 'where is authorization enforced'],
    ['inspect', '--config', 'config.json', '--json'],
    ['doctor', '--config', 'config.json'],
    ['mcp', '--config', 'config.json'],
    ['cache', 'clear', '--config', 'config.json'],
  ];
  for (const argv of planned) {
    const result = await invoke(argv);
    assert.equal(result.code, EXIT_NOT_IMPLEMENTED, `unexpected exit code for ${argv.join(' ')}`);
    assert.notEqual(result.code, EXIT_OK);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not implemented in this build/);
    assert.match(result.stderr, /no work was performed/);
  }
});

test('the not-implemented exit code is outside the reserved product codes', () => {
  for (const reserved of [EXIT_OK, 3, 4, 130]) {
    assert.notEqual(EXIT_NOT_IMPLEMENTED, reserved);
  }
});

test('the help text presents planned commands only as unavailable', () => {
  const text = helpText();
  const disclaimer = text.indexOf('not implemented in this build');
  assert.notEqual(disclaimer, -1, 'the help text must state that planned commands are unavailable');

  for (const command of ['search', 'inspect', 'doctor', 'mcp', 'cache']) {
    const commandLine = new RegExp(`^ {2}${command}\\b`, 'm').exec(text);
    assert.notEqual(commandLine, null, `${command} is not documented in the help text`);
    assert.ok(
      (commandLine?.index ?? 0) > disclaimer,
      `'${command}' is presented as a command before the not-implemented disclaimer`,
    );
  }

  const optionsSection = text.slice(text.indexOf('options:'), disclaimer);
  assert.match(optionsSection, /-h, --help/);
  assert.match(optionsSection, /-V, --version/);
  for (const command of ['search', 'inspect', 'doctor', 'mcp', 'cache']) {
    assert.doesNotMatch(
      optionsSection,
      new RegExp(`\\b${command}\\b`),
      `the available-options section must not advertise '${command}'`,
    );
  }
});
