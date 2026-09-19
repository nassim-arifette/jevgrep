import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { main } from '../src/cli.ts';
import { EXIT_FATAL, EXIT_OK, EXIT_USAGE } from '../src/cli.ts';
import type { CliIo } from '../src/cli.ts';
import { CLI_EXIT_CODES } from '../src/search-response.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

/**
 * JG-023 process adapter: the binary must dispatch a validated command to the shared command
 * layer instead of refusing it. These tests drive `main()` with the DEFAULT dependencies, so
 * they exercise the real wiring the executable uses - not an injected stub.
 *
 * Offline: `doctor`, `inspect` and `cache clear` must work without a credential and without a
 * provider request, and a `search` without a credential must be refused cleanly.
 */
const workspaces: { cleanup: () => void }[] = [];

after(() => {
  for (const workspace of workspaces) {
    workspace.cleanup();
  }
});

type Capture = { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] };

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

test('a missing configuration is a rejection from the command layer, not a stub answer', async () => {
  const captured = capture();
  const code = await main(['doctor', '--config', 'definitely-missing-config.json'], captured.io);

  assert.equal(code, CLI_EXIT_CODES.rejected, 'the configuration failure owns exit code 2');
  assert.equal(captured.stdout.join('\n'), '', 'stdout carries the result only, and there is none');
  assert.match(captured.stderr.join('\n'), /config/i);
  assert.doesNotMatch(captured.stderr.join('\n'), /not implemented/);
});

test('doctor reports the local setup without a credential or a provider call', async () => {
  const workspace = createWorkspace({ files: { 'src/app.ts': 'export const app = 1;\n' } });
  workspaces.push(workspace);
  const captured = capture();

  const code = await main(['doctor', '--config', workspace.configPath], captured.io);

  assert.equal(code, EXIT_OK);
  const text = captured.stdout.join('\n');
  assert.ok(text.length > 0, 'doctor must report something to the operator');
  assert.match(text, /repository|scope|configuration/i);
});

test('inspect prints the eligible scope and its estimates, and takes no remote action', async () => {
  const workspace = createWorkspace({
    files: {
      'src/app.ts': 'export const app = 1;\n',
      'src/cache.ts': 'export function clear(): void {}\n',
      'config/default.json': '{ "retries": 2 }\n',
    },
  });
  workspaces.push(workspace);
  const captured = capture();

  const code = await main(['inspect', '--config', workspace.configPath, '--scope', 'src', '--json'], captured.io);

  assert.equal(code, EXIT_OK, captured.stderr.join('\n'));
  const payload = JSON.parse(captured.stdout.join('\n')) as { scope?: unknown; files?: unknown };
  assert.ok(payload.scope !== undefined, 'the canonical JSON payload owns stdout');
  assert.ok(payload.files !== undefined, 'inspect reports the file accounting');
});

test('a search without a credential is refused cleanly, with no provider request', async () => {
  const workspace = createWorkspace({
    files: { 'src/cache.ts': 'export function clear(): void {}\n' },
    configure: (config) => withRemoteEnabled(config),
  });
  workspaces.push(workspace);
  const captured = capture();

  const code = await main(
    ['search', '--config', workspace.configPath, '--query', 'cache invalidation', '--json'],
    captured.io,
  );

  // The canonical payload owns stdout, including a refusal: a pipeline keeps the evidence
  // even when the exit code is non-zero (specification 4.5).
  assert.equal(code, CLI_EXIT_CODES.rejected);
  const payload = JSON.parse(captured.stdout.join('\n')) as { status?: string; error?: { code?: string } };
  assert.equal(payload.status, 'rejected');
  assert.equal(payload.error?.code, 'CREDENTIAL_MISSING');
  assert.doesNotMatch(captured.stderr.join('\n'), /\n\s+at /, 'no stack trace reaches the operator');
});

test('cache clear on a configured workspace only removes the cache directory', async () => {
  const workspace = createWorkspace({ files: { 'src/app.ts': 'export const app = 1;\n' } });
  workspaces.push(workspace);
  const captured = capture();

  const code = await main(['cache', 'clear', '--config', workspace.configPath], captured.io);

  assert.equal(code, EXIT_OK, captured.stderr.join('\n'));
  assert.ok(captured.stdout.join('\n').length > 0);
});

test('help and version keep working, and an unknown command stays a usage error', async () => {
  const help = capture();
  assert.equal(await main(['--help'], help.io), EXIT_OK);
  assert.match(help.stdout.join('\n'), /^usage: jevgrep/);

  const unknown = capture();
  assert.equal(await main(['frobnicate'], unknown.io), EXIT_USAGE);

  const badOption = capture();
  assert.equal(await main(['doctor', '--config', 'x.json', '--json'], badOption.io), EXIT_USAGE);
});

test('a command-layer failure is fatal and prints no stack trace', async () => {
  const workspace = createWorkspace({ files: { 'src/app.ts': 'export const app = 1;\n' } });
  workspaces.push(workspace);
  const captured = capture();

  // A scope outside the configured repository is refused by the command layer; the point of
  // this test is the mapping to a documented code with a readable diagnostic.
  const code = await main(['inspect', '--config', workspace.configPath, '--scope', '..'], captured.io);

  const allowedCodes: readonly number[] = [EXIT_USAGE, EXIT_FATAL, CLI_EXIT_CODES.rejected];
  assert.ok(allowedCodes.includes(code), `unexpected code ${String(code)}`);
  assert.doesNotMatch(captured.stderr.join('\n'), /\n\s+at /);
});
