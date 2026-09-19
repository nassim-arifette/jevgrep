import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EXIT_FATAL,
  EXIT_OK,
  EXIT_USAGE,
  helpText,
  main,
  readPackageVersion,
  stdoutLine,
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

test('stdout adds exactly one final newline to plain and already measured output', () => {
  assert.equal(stdoutLine('plain output'), 'plain output\n');
  assert.equal(stdoutLine('measured output\n'), 'measured output\n');
});

/** Run one command with an injected runner, capturing its output and exit code. */
async function invokeWith(runCommand: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const captured = capture();
  const code = await main(['doctor', '--config', 'config.json'], captured.io, {
    readVersion: () => '0.0.0',
    runCommand: (): Promise<number> => runCommand(),
  });
  return { code, stdout: captured.stdout.join('\n'), stderr: captured.stderr.join('\n') };
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

test('--help after a command prints that command help and succeeds', async () => {
  for (const command of ['search', 'inspect', 'doctor', 'mcp']) {
    const result = await invoke([command, '--help']);
    assert.equal(result.code, EXIT_OK, `${command} --help`);
    assert.match(result.stdout, new RegExp(`^usage: jevgrep ${command}`));
    assert.equal(result.stderr, '');
  }
  const cache = await invoke(['cache', 'clear', '--help']);
  assert.equal(cache.code, EXIT_OK);
  assert.match(cache.stdout, /^usage: jevgrep cache clear/);

  const unknown = await invoke(['frobnicate', '--help']);
  assert.equal(unknown.code, EXIT_USAGE);
  assert.equal(unknown.stdout, '');
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

test('every documented command dispatches instead of being refused', async () => {
  // A missing configuration file is the cheapest real dispatch: the command layer owns the
  // rejection and reports it, which proves the process adapter is wired.
  const commands: readonly (readonly string[])[] = [
    ['search', '--config', 'missing-config.json', '--query', 'where is authorization enforced'],
    ['inspect', '--config', 'missing-config.json', '--json'],
    ['doctor', '--config', 'missing-config.json'],
    ['mcp', '--config', 'missing-config.json'],
    ['cache', 'clear', '--config', 'missing-config.json'],
  ];
  for (const argv of commands) {
    const result = await invoke(argv);
    assert.equal(result.code, EXIT_USAGE, `unexpected exit code for ${argv.join(' ')}`);
    assert.doesNotMatch(result.stderr, /not implemented/, 'no command is a stub any more');
    assert.match(result.stderr, /config/i, `the configuration failure must be explained for ${argv.join(' ')}`);
  }
});

test('the help text lists the documented commands and the exit-code contract', () => {
  const text = helpText();
  assert.match(text, /^usage: jevgrep/);
  for (const command of ['search', 'inspect', 'doctor', 'mcp', 'cache']) {
    assert.match(text, new RegExp(`^ {2}${command}\\b`, 'm'), `${command} is not listed`);
  }
  assert.doesNotMatch(text, /not implemented/, 'the scaffold disclaimer is gone once the commands exist');
  for (const code of ['0', '2', '3', '4', '130']) {
    assert.match(text, new RegExp(`^ {2}${code}\\s`, 'm'), `exit code ${code} is not documented`);
  }
});

test('a validated command is dispatched to the injected runner', async () => {
  const seen: unknown[] = [];
  const captured = capture();
  const code = await main(['inspect', '--config', 'config.json', '--scope', 'src', '--json'], captured.io, {
    readVersion: () => '0.0.0',
    runCommand: (command: unknown) => {
      seen.push(command);
      return Promise.resolve(0);
    },
  });

  assert.equal(code, EXIT_OK);
  assert.equal(seen.length, 1, 'the runner must be called exactly once');
  assert.deepEqual(seen[0], { kind: 'inspect', config: 'config.json', scope: ['src'], json: true });
});

test('a search command reaches the runner with its validated request', async () => {
  const seen: { readonly request?: { readonly query: string; readonly scope: readonly string[] } }[] = [];
  const captured = capture();
  const code = await main(['search', '--config', 'config.json', '--query', 'where is auth', '--scope', 'src'], captured.io, {
    readVersion: () => '0.0.0',
    runCommand: (command: unknown) => {
      seen.push(command as { request?: { query: string; scope: readonly string[] } });
      return Promise.resolve(0);
    },
  });

  assert.equal(code, EXIT_OK);
  assert.equal(seen[0]?.request?.query, 'where is auth');
  assert.deepEqual(seen[0]?.request?.scope, ['src']);
});

test('the runner decides the exit code, and its failure is a fatal code without a stack trace', async () => {
  const partial = await invokeWith(() => Promise.resolve(3));
  assert.equal(partial.code, 3, 'the product contract reserves 3 for a partial result');

  const failed = await invokeWith(() => {
    throw new Error('provider exploded at C:/secret/path');
  });
  assert.equal(failed.code, EXIT_FATAL);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /command failed/);
  assert.doesNotMatch(failed.stderr, /secret\/path|\\n\\s+at /, 'no path or stack trace may reach the caller');
});

test('an invalid command never reaches the runner', async () => {
  let called = false;
  const captured = capture();
  const code = await main(['search', '--config', 'config.json'], captured.io, {
    readVersion: () => '0.0.0',
    runCommand: () => {
      called = true;
      return Promise.resolve(0);
    },
  });

  assert.equal(code, EXIT_USAGE);
  assert.equal(called, false, 'arguments must be validated before any work is dispatched');
});

test('without an injected runner the command layer executes the command', async () => {
  const result = await invoke(['doctor', '--config', 'missing-config.json']);
  assert.equal(result.code, EXIT_USAGE, 'the real command owns the outcome, not a stub message');
  assert.match(result.stderr, /config/i);
});

test('a short error code is shown, a message or a path is not', async () => {
  const withCode = await invokeWith(() => {
    const failure = Object.assign(new Error('boom at C:/secret/path'), { code: 'PROVIDER_UNAVAILABLE' });
    throw failure;
  });
  assert.equal(withCode.code, EXIT_FATAL);
  assert.match(withCode.stderr, /PROVIDER_UNAVAILABLE/);
  assert.doesNotMatch(withCode.stderr, /secret/, 'an error message may carry paths or source and stays hidden');

  const withJunkCode = await invokeWith(() => {
    const failure = Object.assign(new Error('boom'), { code: 'not-a-code with spaces' });
    throw failure;
  });
  assert.doesNotMatch(withJunkCode.stderr, /not-a-code/);
});

test('a runner that returns a non-integer exit code is a fatal failure', async () => {
  const result = await invokeWith(() => Promise.resolve(Number.NaN));
  assert.equal(result.code, EXIT_FATAL);
  assert.match(result.stderr, /command failed/);
});
