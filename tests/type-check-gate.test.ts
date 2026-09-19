import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { repoRoot } from './helpers/cli-runner.ts';

/**
 * JG-001 acceptance criterion: a type error must fail the type check with a non-zero exit
 * code, and `npm run typecheck` (the documented command) must propagate that code.
 *
 * The proof is a chain, because injecting a deliberate error into the shared tree is not
 * safe when several processes (or several agents) run the suite in the same checkout:
 *
 * 1. the documented script is exactly `tsc -p tsconfig.json` (asserted in
 *    tests/project-config.test.ts), so its exit code is the compiler's exit code;
 * 2. the project's own compiler options reject the deliberate error, proven in a scratch
 *    project that extends the real tsconfig.json (no file is written inside the checkout);
 * 3. the untouched project passes its own type check.
 *
 * An earlier version wrote the broken file into tests/ inside the checkout, which broke a
 * concurrent `npm run typecheck` in another process.
 */
const tscEntry = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const projectConfig = join(repoRoot, 'tsconfig.json');

const scratchRoots: string[] = [];

after(() => {
  for (const root of scratchRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

type CommandResult = {
  readonly code: number | null;
  readonly output: string;
};

function run(command: string, args: readonly string[], cwd: string): CommandResult {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function projectTypeCheck(cwd: string = repoRoot): CommandResult {
  return run(process.execPath, [tscEntry, '-p', projectConfig], cwd);
}

/**
 * Scratch project that reuses the project's compiler options and adds exactly one file.
 * It lives outside the checkout, so it cannot disturb a concurrent run.
 */
function scratchProject(contents: string): { readonly dir: string; readonly file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jevgrep-gate-'));
  scratchRoots.push(dir);
  const file = join(dir, 'probe.ts');
  writeFileSync(file, contents, 'utf8');
  const extendsPath = relative(dir, projectConfig).replaceAll('\\', '/');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: extendsPath,
        compilerOptions: {
          noEmit: true,
          types: ['node'],
          typeRoots: [relative(dir, join(repoRoot, 'node_modules', '@types')).replaceAll('\\', '/')],
        },
        include: ['./probe.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { dir, file };
}

function scratchTypeCheck(contents: string): { readonly code: number | null; readonly output: string; readonly dir: string } {
  const project = scratchProject(contents);
  const result = run(process.execPath, [tscEntry, '-p', join(project.dir, 'tsconfig.json')], project.dir);
  return { ...result, dir: project.dir };
}

test('the untouched project passes its own type check', { timeout: 300_000 }, () => {
  const result = projectTypeCheck();
  assert.equal(result.code, 0, `the project must type check cleanly:\n${result.output}`);
});

test('the project compiler options reject a deliberate type error with a non-zero code', { timeout: 300_000 }, () => {
  const result = scratchTypeCheck('export const wrong: string = 1;\n');
  assert.notEqual(result.code, 0, 'a deliberate type error must fail the type check');
  assert.match(result.output, /probe\.ts/);
  assert.match(result.output, /error TS\d+/);
});

test('the strict options reject codes a laxer project would accept', { timeout: 300_000 }, () => {
  // Three independent errors, each relying on one of the strict options this project sets:
  // noUncheckedIndexedAccess, exactOptionalPropertyTypes and noImplicitReturns.
  const strictProbe = [
    'export function first(values: readonly string[]): string {',
    '  return values[0].toUpperCase();',
    '}',
    'export type Options = { readonly label?: string };',
    'export function label(options: Options): string | undefined {',
    '  const copy: Options = { label: undefined };',
    '  return copy.label ?? options.label;',
    '}',
    'export function classify(value: number): string {',
    "  if (value > 0) { return 'positive'; }",
    "  if (value < 0) { return 'negative'; }",
    '}',
    '',
  ].join('\n');
  const result = scratchTypeCheck(strictProbe);
  assert.notEqual(result.code, 0, 'the strict options must reject this probe');
  assert.match(result.output, /error TS\d+/);
});

test('the type-check gate works outside the checkout', () => {
  const probe = scratchProject('export const value = 1;\n');
  assert.equal(probe.dir.startsWith(repoRoot), false, 'scratch projects live outside the checkout');
  assert.equal(probe.file.startsWith(repoRoot), false, 'the probe file lives outside the checkout');
  assert.equal(readFileSync(probe.file, 'utf8'), 'export const value = 1;\n');

  // No ignore rule is needed, because the suite never writes a gate artifact any more.
  const ignoreRules = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
  assert.doesNotMatch(ignoreRules, /__type_check_gate__/);
});
