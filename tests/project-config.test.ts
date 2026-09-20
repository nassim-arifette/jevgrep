import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from './helpers/cli-runner.ts';

/**
 * Package-level controls for JG-001: pinned runtime and dependency versions, the
 * required scripts and the executable entry point. These assertions keep the
 * scaffold reproducible on Windows and Linux.
 */
type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly publishConfig: { readonly access: string };
  readonly type: string;
  readonly engines: { readonly node: string };
  readonly bin: Record<string, string>;
  readonly files: readonly string[];
  readonly scripts: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
};

const manifest: Manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Manifest;
const nvmrc = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim();

test('the runtime version is pinned once and accepted by package.json', () => {
  const [major] = nvmrc.split('.');
  assert.match(nvmrc, /^\d+\.\d+\.\d+$/, '.nvmrc must pin an exact Node.js version');
  const currentNode = process.versions.node;
  assert.equal(
    currentNode.split('.')[0],
    major,
    `the suite must run on the pinned Node.js major version (${nvmrc}), but runs on ${currentNode}`,
  );
  assert.match(manifest.engines.node, new RegExp(`>=${String(major)}\\.0\\.0`));
  assert.match(manifest.engines.node, new RegExp(`<${String(Number(major) + 1)}\\.0\\.0`));
});

test('every declared dependency is pinned to an exact version', () => {
  const groups: readonly (readonly [string, Record<string, string> | undefined])[] = [
    ['dependencies', manifest.dependencies],
    ['devDependencies', manifest.devDependencies],
  ];
  for (const [group, entries] of groups) {
    for (const [name, version] of Object.entries(entries ?? {})) {
      assert.match(version, /^(?:npm:typescript@)?\d+\.\d+\.\d+$/, `${group}.${name} must be an exact pinned version`);
    }
  }
  // The runtime dependency list is an allowlist, not a free-for-all: each entry is a
  // decision recorded in an issue report. `tiktoken` is the reference response counter
  // pinned by JG-006; the Vercel adapter uses the official AI SDK evaluation API.
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ['@ai-sdk/gateway', 'ai', 'tiktoken', 'typescript-parser'],
    'a new runtime dependency needs its own recorded decision before it is added here',
  );
});

test('the development scripts cover compile, type check, test and smoke', () => {
  for (const script of ['build', 'typecheck', 'test', 'smoke', 'verify']) {
    assert.ok(manifest.scripts[script] !== undefined, `missing npm script '${script}'`);
  }
  assert.equal(manifest.scripts['typecheck'], 'node node_modules/typescript/bin/tsc -p tsconfig.json');
  assert.equal(manifest.scripts['build'], 'node node_modules/typescript/bin/tsc -p tsconfig.build.json && node scripts/make-executable.ts');
  // Explicit suite roots keep fixture repositories out while still discovering the
  // shared-contract tests in their dedicated directory (review nit N6).
  assert.equal(
    manifest.scripts['test'],
    'node --test "tests/*.test.ts" "tests/contract/*.test.ts"',
  );
  assert.match(manifest.scripts['smoke'] ?? '', /^node scripts\/smoke\.ts$/);
  const verify = manifest.scripts['verify'] ?? '';
  for (const step of ['npm run typecheck', 'npm test', 'npm run build', 'npm run smoke']) {
    assert.ok(verify.includes(step), `npm run verify must include '${step}'`);
  }
});

test('the package exposes one executable entry point built from src/cli.ts', () => {
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(Object.keys(manifest.bin), ['jevgrep']);
  assert.equal(manifest.bin['jevgrep'], 'dist/cli.js');
  assert.deepEqual(manifest.files, ['dist']);

  const buildConfig: { compilerOptions: { outDir: string; rootDir: string } } = JSON.parse(
    readFileSync(join(repoRoot, 'tsconfig.build.json'), 'utf8'),
  ) as { compilerOptions: { outDir: string; rootDir: string } };
  assert.equal(buildConfig.compilerOptions.outDir, 'dist');
  assert.equal(buildConfig.compilerOptions.rootDir, 'src');

  const source = readFileSync(join(repoRoot, 'src', 'cli.ts'), 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node'), 'src/cli.ts must start with a shebang');
});

test('the strict type-checking options stay enabled', () => {
  const config: { compilerOptions: Record<string, unknown> } = JSON.parse(
    readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8'),
  ) as { compilerOptions: Record<string, unknown> };
  const options = config.compilerOptions;
  for (const option of [
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noUnusedLocals',
    'noUnusedParameters',
    'isolatedModules',
    'verbatimModuleSyntax',
    'erasableSyntaxOnly',
  ]) {
    assert.equal(options[option], true, `tsconfig.json must set "${option}": true`);
  }
});
