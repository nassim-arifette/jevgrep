import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT_NOT_IMPLEMENTED, EXIT_OK, EXIT_USAGE } from '../src/cli.ts';
import { repoRoot, runCli, sourceEntry } from './helpers/cli-runner.ts';

const manifest: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = (manifest as { version: string }).version;

test('the executable entry point implements --help and --version', async () => {
  const help = await runCli(sourceEntry, ['--help']);
  assert.equal(help.code, EXIT_OK);
  assert.match(help.stdout, /^usage: jevgrep --help \| --version/);
  assert.equal(help.stderr, '');

  const versionResult = await runCli(sourceEntry, ['--version']);
  assert.equal(versionResult.code, EXIT_OK);
  assert.equal(versionResult.stdout.trim(), `jevgrep ${version}`);
  assert.equal(versionResult.stderr, '');
});

test('the executable entry point rejects planned and unknown commands', async () => {
  const search = await runCli(sourceEntry, ['search', '--config', 'config.json', '--query', 'authorization checks']);
  assert.equal(search.code, EXIT_NOT_IMPLEMENTED);
  assert.equal(search.stdout, '');
  assert.match(search.stderr, /not implemented in this build/);

  // The documented surface requires the trusted configuration: a missing flag is a usage
  // error, not a "not implemented" answer.
  const missingConfig = await runCli(sourceEntry, ['search', '--query', 'authorization checks']);
  assert.equal(missingConfig.code, EXIT_USAGE);
  assert.match(missingConfig.stderr, /--config/);

  const unknown = await runCli(sourceEntry, ['frobnicate']);
  assert.equal(unknown.code, EXIT_USAGE);
  assert.match(unknown.stderr, /unknown command 'frobnicate'/);

  const noArgs = await runCli(sourceEntry, []);
  assert.equal(noArgs.code, EXIT_USAGE);
  assert.match(noArgs.stderr, /no command given/);
});

test('the CLI reports the same version from an unrelated working directory', async () => {
  const result = await runCli(sourceEntry, ['--version'], tmpdir());
  assert.equal(result.code, EXIT_OK);
  assert.equal(result.stdout.trim(), `jevgrep ${version}`);
});

test('running the entry point performs no work and needs no provider key', async () => {
  // runCli strips JEV/TYPESAFE/API_KEY/ACCESS_TOKEN variables from the environment,
  // so a passing run also shows that no credential is required.
  const result = await runCli(sourceEntry, ['search', '--config', 'config.json', '--query', 'anything']);
  assert.equal(result.code, EXIT_NOT_IMPLEMENTED);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no work was performed/);
});
