import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXIT_OK, EXIT_USAGE } from '../src/cli.ts';
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

test('the executable entry point runs a command and rejects a bad one', async () => {
  // A missing configuration is refused by the command layer, which proves the process
  // adapter dispatches instead of printing a stub answer.
  const search = await runCli(sourceEntry, ['search', '--config', 'missing-config.json', '--query', 'authorization checks']);
  assert.equal(search.code, EXIT_USAGE);
  assert.match(search.stderr, /config/i);
  assert.doesNotMatch(search.stderr, /not implemented/);

  // The documented surface requires the trusted configuration: a missing flag is a usage
  // error, reported before any command runs.
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

test('a command documents itself through the executable', async () => {
  const help = await runCli(sourceEntry, ['doctor', '--help']);
  assert.equal(help.code, EXIT_OK);
  assert.match(help.stdout, /^usage: jevgrep doctor --config <path>/);
  assert.match(help.stdout, /never needs a credential/);
  assert.equal(help.stderr, '');
});

test('the CLI reports the same version from an unrelated working directory', async () => {
  const result = await runCli(sourceEntry, ['--version'], tmpdir());
  assert.equal(result.code, EXIT_OK);
  assert.equal(result.stdout.trim(), `jevgrep ${version}`);
});

test('running the entry point needs no provider key', async () => {
  // runCli strips JEV/TYPESAFE/API_KEY/ACCESS_TOKEN variables from the environment, so this
  // run shows the local commands need no credential and the process stays honest about it.
  const result = await runCli(sourceEntry, ['doctor', '--config', 'missing-config.json']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.stderr, /config/i);
  assert.equal(result.stdout, '');
});
