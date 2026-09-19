import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliArguments } from '../src/cli-args.ts';

/**
 * JG-023 preparation (junior pilot): the argument surface of specification 4.5 and the
 * request limits of 4.1 and 7.3.
 *
 * Parsing is pure: it validates shapes, arities and documented limits, and it never touches
 * the configuration file, the repository or the provider. Deep request validation is
 * delegated to the shared contract (src/contracts.ts) so the CLI cannot drift from MCP.
 */
const deps = { readFile: (path: string): string => (path === 'query.txt' ? 'multi\nline\ttabbed\n' : '') };

function parse(argv: readonly string[]): ReturnType<typeof parseCliArguments> {
  return parseCliArguments(argv, deps);
}

function expectCommand(argv: readonly string[]): Extract<ReturnType<typeof parseCliArguments>, { kind: 'command' }> {
  const result = parse(argv);
  assert.equal(result.kind, 'command', `expected a command, got: ${JSON.stringify(result)}`);
  if (result.kind !== 'command') {
    throw new Error('unreachable');
  }
  return result;
}

function expectError(argv: readonly string[]): string {
  const result = parse(argv);
  assert.equal(result.kind, 'error', `expected a refusal, got: ${JSON.stringify(result)}`);
  if (result.kind !== 'error') {
    throw new Error('unreachable');
  }
  assert.ok(result.message.length > 0);
  return result.message;
}

test('the documented command forms parse', () => {
  const doctor = expectCommand(['doctor', '--config', 'C:/work/config.json']);
  assert.deepEqual(doctor.command, { kind: 'doctor', config: 'C:/work/config.json' });

  const inspect = expectCommand(['inspect', '--config', 'config.json', '--scope', 'src', '--scope', 'tests', '--json']);
  assert.deepEqual(inspect.command, {
    kind: 'inspect',
    config: 'config.json',
    scope: ['src', 'tests'],
    json: true,
  });

  const search = expectCommand([
    'search', '--config', 'config.json', '--query', 'where is authorization enforced',
    '--scope', 'src', '--max-context-tokens', '4000', '--json',
  ]);
  assert.equal(search.command.kind, 'search');
  if (search.command.kind !== 'search') {
    return;
  }
  assert.equal(search.command.json, true);
  assert.equal(search.command.request.query, 'where is authorization enforced');
  assert.deepEqual(search.command.request.scope, ['src']);
  assert.equal(search.command.request.max_context_tokens, 4000);
  assert.equal(search.command.request.allow_partial_scan, false);

  const mcp = expectCommand(['mcp', '--config', 'config.json']);
  assert.deepEqual(mcp.command, { kind: 'mcp', config: 'config.json' });

  const cache = expectCommand(['cache', 'clear', '--config', 'config.json']);
  assert.deepEqual(cache.command, { kind: 'cache-clear', config: 'config.json' });
});

test('defaults follow the specification', () => {
  const search = expectCommand(['search', '--config', 'config.json', '--query', 'anything']);
  assert.equal(search.command.kind, 'search');
  if (search.command.kind !== 'search') {
    return;
  }
  assert.deepEqual(search.command.request.scope, ['.']);
  assert.equal(search.command.request.max_context_tokens, 4_000);
  assert.equal(search.command.request.allow_partial_scan, false);
  assert.equal(search.command.json, false);

  const inspect = expectCommand(['inspect', '--config', 'config.json']);
  assert.equal(inspect.command.kind, 'inspect');
  if (inspect.command.kind === 'inspect') {
    assert.deepEqual(inspect.command.scope, ['.']);
    assert.equal(inspect.command.json, false);
  }
});

test('a missing --config is refused for every command', () => {
  for (const argv of [
    ['doctor'],
    ['inspect', '--scope', 'src'],
    ['search', '--query', 'something'],
    ['mcp'],
    ['cache', 'clear'],
  ]) {
    assert.match(expectError(argv), /--config/);
  }
});

test('search requires exactly one query source', () => {
  assert.match(expectError(['search', '--config', 'config.json']), /--query|--query-file/);
  assert.match(
    expectError(['search', '--config', 'config.json', '--query', 'a', '--query-file', 'query.txt']),
    /--query-file|--query/,
  );
});

test('--query-file is read, so multiline queries survive the shell', () => {
  const search = expectCommand(['search', '--config', 'config.json', '--query-file', 'query.txt']);
  assert.equal(search.command.kind, 'search');
  if (search.command.kind === 'search') {
    assert.equal(search.command.request.query, 'multi\nline\ttabbed\n');
  }
});

test('the response budget is an integer inside the documented range', () => {
  for (const value of ['abc', '4000.5', '1023', '16001', '0', '-1']) {
    assert.match(
      expectError(['search', '--config', 'config.json', '--query', 'q', '--max-context-tokens', value]),
      /max-context-tokens|tokens|integer/i,
    );
  }
  const accepted = expectCommand(['search', '--config', 'config.json', '--query', 'q', '--max-context-tokens', '16000']);
  assert.equal(accepted.command.kind, 'search');
  if (accepted.command.kind === 'search') {
    assert.equal(accepted.command.request.max_context_tokens, 16_000);
  }
});

test('--allow-partial is a search-only flag and needs no value', () => {
  const search = expectCommand(['search', '--config', 'config.json', '--query', 'q', '--allow-partial']);
  assert.equal(search.command.kind, 'search');
  if (search.command.kind === 'search') {
    assert.equal(search.command.request.allow_partial_scan, true);
  }
  assert.match(expectError(['doctor', '--config', 'config.json', '--allow-partial']), /--allow-partial/);
});

test('scope entries are refused when they are absolute or empty', () => {
  assert.match(expectError(['search', '--config', 'config.json', '--query', 'q', '--scope', '/etc']), /scope/i);
  assert.match(expectError(['inspect', '--config', 'config.json', '--scope', '']), /scope/i);
  assert.match(expectError(['inspect', '--config', 'config.json', '--scope', '..']), /scope/i);
});

test('options that do not belong to a command are refused', () => {
  assert.match(expectError(['mcp', '--config', 'config.json', '--json']), /--json/);
  assert.match(expectError(['doctor', '--config', 'config.json', '--query', 'q']), /--query/);
  assert.match(expectError(['inspect', '--config', 'config.json', '--max-context-tokens', '2000']), /--max-context-tokens/);
});

test('unknown options and missing values are refused, never thrown', () => {
  assert.match(expectError(['search', '--config', 'config.json', '--query', 'q', '--verbose']), /--verbose/);
  assert.match(expectError(['search', '--config']), /--config/);
  assert.match(expectError(['search', '--config', 'config.json', '--query']), /--query/);
  assert.match(expectError(['cache', '--config', 'config.json']), /cache/i);
  assert.match(expectError(['cache', 'wipe', '--config', 'config.json']), /wipe/);
});

test('parsing has no side effect on the filesystem or the environment', () => {
  // The configuration path may not exist yet: reading it belongs to the configuration
  // loader, not to argument parsing.
  const search = expectCommand(['search', '--config', 'C:/does/not/exist.json', '--query', 'q']);
  assert.equal(search.command.kind, 'search');
  const doctor = expectCommand(['doctor', '--config', 'C:/does/not/exist.json']);
  assert.equal(doctor.command.kind, 'doctor');
});
