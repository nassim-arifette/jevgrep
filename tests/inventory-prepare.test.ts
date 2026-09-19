import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AuthorizedRoot } from '../src/source/authorization.ts';
import { inventoryScope } from '../src/source/inventory.ts';
import type { InventoryOptions } from '../src/source/inventory.ts';
import { prepareScope, exclusionCounts, findCredentialPattern } from '../src/source/prepare.ts';
import { createSnapshot, SnapshotError } from '../src/source/snapshot.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

/**
 * Inventory, exclusions and snapshots (JG-010 and JG-011).
 *
 * The inventory is a function of the working tree, never of the question, and every
 * exclusion has an explicit, countable reason. Snapshots preserve the original bytes
 * exactly: a returned excerpt has to be a slice of what was read and hashed.
 */
const created: { cleanup(): void }[] = [];

function workspace(files: Record<string, string>): ReturnType<typeof createWorkspace> {
  const space = createWorkspace({ files });
  created.push(space);
  return space;
}

after(() => {
  for (const space of created) {
    space.cleanup();
  }
});

const defaultOptions: InventoryOptions = {
  respectGitignore: true,
  maxFileBytes: 1_048_576,
  extraDenyGlobs: [],
};

function inventoryOf(space: ReturnType<typeof createWorkspace>, scope: string[] = ['.'], options: Partial<InventoryOptions> = {}): ReturnType<typeof inventoryScope> {
  return inventoryScope(AuthorizedRoot.open(space.repositoryRoot), scope, { ...defaultOptions, ...options });
}

test('the eligible list is deterministic and independent of any question', () => {
  const space = workspace({
    'src/b.ts': 'export const b = 2;\n',
    'src/a.ts': 'export const a = 1;\n',
    'docs/readme.md': '# title\n',
  });
  const first = inventoryOf(space);
  const second = inventoryOf(space);
  assert.deepEqual(first.files.map((file) => file.relativePath), second.files.map((file) => file.relativePath));
  assert.deepEqual(first.files.map((file) => file.relativePath), ['docs/readme.md', 'src/a.ts', 'src/b.ts']);
  assert.equal(first.complete, true);
});

test('administrative, credential, dependency and build entries are excluded with their reason', () => {
  const space = workspace({
    'src/app.ts': 'export const app = 1;\n',
    '.env': 'TOKEN=abc\n',
    '.env.local': 'TOKEN=def\n',
    '.npmrc': '//registry:_authToken=abc\n',
    'deploy/server.pem': '-----BEGIN PRIVATE KEY-----\n',
    'node_modules/pkg/index.js': 'module.exports = 1;\n',
    'dist/bundle.js': 'console.log(1);\n',
    'generated/api.ts': 'export const generated = true;\n',
    'vendor/lib.js': 'export const vendored = 1;\n',
    'src/app.min.js': 'var a=1;\n',
    'package-lock.json': '{}\n',
    'assets/logo.svg': '<svg/>\n',
  });
  const inventory = inventoryOf(space);
  const paths = inventory.files.map((file) => file.relativePath);
  assert.deepEqual(paths, ['assets/logo.svg', 'src/app.ts']);

  const reasons = new Map(inventory.excluded.map((entry) => [entry.relativePath, entry.reason]));
  assert.equal(reasons.get('.env'), 'credential_file');
  assert.equal(reasons.get('.env.local'), 'credential_file');
  assert.equal(reasons.get('.npmrc'), 'credential_file');
  assert.equal(reasons.get('deploy/server.pem'), 'credential_file');
  assert.equal(reasons.get('src/app.min.js'), 'minified');
  assert.equal(reasons.get('package-lock.json'), 'generated');

  const directories = new Map(inventory.excludedDirectories.map((entry) => [entry.relativePath, entry.reason]));
  assert.equal(directories.get('node_modules'), 'dependency');
  assert.equal(directories.get('dist'), 'build_output');
  assert.equal(directories.get('generated'), 'generated');
  assert.equal(directories.get('vendor'), 'dependency');
  assert.ok(inventory.excluded.every((entry) => !entry.relativePath.startsWith('node_modules')),
    'an unvisited directory contributes no invented descendant counts');
});

test('every valid UTF-8 language is searchable while only JS and TS use syntax chunking', () => {
  const space = workspace({
    'Dockerfile': 'FROM node:24\nRUN npm ci\n',
    'src/main.go': 'package main\nfunc main() {}\n',
    'src/main.py': 'def main():\n    return 1\n',
    'src/lib.rs': 'pub fn run() -> bool { true }\n',
    'src/Main.java': 'class Main { void run() {} }\n',
    'src/Program.cs': 'class Program { static void Main() {} }\n',
    'src/main.cpp': '#include <iostream>\nint main() { return 0; }\n',
    'src/app.rb': 'def run\n  true\nend\n',
    'src/index.php': '<?php function run() { return true; }\n',
    'src/App.swift': 'func run() -> Bool { true }\n',
    'src/Main.kt': 'fun run(): Boolean = true\n',
    'src/app.ts': 'export function run(): boolean { return true; }\n',
    'assets/diagram.svg': '<svg><text>request flow</text></svg>\n',
  });

  const inventory = inventoryOf(space);
  assert.deepEqual(inventory.files.map((file) => file.relativePath), [
    'Dockerfile', 'assets/diagram.svg', 'src/App.swift', 'src/Main.java', 'src/Main.kt',
    'src/Program.cs', 'src/app.rb', 'src/app.ts', 'src/index.php', 'src/lib.rs',
    'src/main.cpp', 'src/main.go', 'src/main.py',
  ]);
  assert.equal(inventory.excludedByReason['unsupported_format'], undefined);

  const prepared = prepareScope(AuthorizedRoot.open(space.repositoryRoot), ['.'], { inventory: defaultOptions });
  assert.equal(prepared.files.length, 13);
  for (const file of prepared.files) {
    assert.equal(file.strategy, file.snapshot.relativePath.endsWith('.ts') ? 'syntax' : 'line-window',
      file.snapshot.relativePath);
    assert.ok(file.fragments.length > 0, `${file.snapshot.relativePath} must be searchable`);
  }
});

test('gitignore is hierarchical and .jevgrepignore can only narrow', () => {
  const space = workspace({
    '.gitignore': 'ignored-by-git.ts\nnested/\n',
    'ignored-by-git.ts': 'export const hidden = 1;\n',
    'nested/deep.ts': 'export const deep = 1;\n',
    'src/.gitignore': 'local-only.ts\n',
    'src/local-only.ts': 'export const local = 1;\n',
    'src/keep.ts': 'export const keep = 1;\n',
    'src/narrowed.ts': 'export const narrowed = 1;\n',
    '.jevgrepignore': 'src/narrowed.ts\n!ignored-by-git.ts\n',
  });
  const inventory = inventoryOf(space);
  const paths = inventory.files.map((file) => file.relativePath);
  assert.deepEqual(paths, ['.gitignore', '.jevgrepignore', 'src/.gitignore', 'src/keep.ts']);

  const reasons = new Map(inventory.excluded.map((entry) => [entry.relativePath, entry.reason]));
  assert.equal(reasons.get('ignored-by-git.ts'), 'gitignored', 'a .jevgrepignore negation cannot widen eligibility');
  assert.equal(reasons.get('src/local-only.ts'), 'gitignored');
  assert.equal(reasons.get('src/narrowed.ts'), 'jevgrepignored');
});

test('an explicitly requested file that a rule refuses stays refused', () => {
  const space = workspace({
    '.gitignore': 'secret-notes.md\n',
    'secret-notes.md': '# notes\n',
    '.env': 'TOKEN=abc\n',
    'src/app.ts': 'export const app = 1;\n',
  });
  const inventory = inventoryOf(space, ['secret-notes.md', '.env', 'src/app.ts']);
  assert.deepEqual(inventory.files.map((file) => file.relativePath), ['src/app.ts']);
  assert.equal(inventory.excluded.length, 2);
});

test('operator deny globs win over inclusion', () => {
  const space = workspace({
    'src/app.ts': 'export const app = 1;\n',
    'src/private/keys.ts': 'export const keys = 1;\n',
  });
  const inventory = inventoryOf(space, ['.'], { extraDenyGlobs: ['src/private/**'] });
  assert.deepEqual(inventory.files.map((file) => file.relativePath), ['src/app.ts']);
  assert.equal(inventory.excludedDirectories[0]?.reason, 'operator_denied');
});

test('overlapping scope entries contribute one file, and size limits exclude explicitly', () => {
  const space = workspace({
    'src/app.ts': 'export const app = 1;\n',
    'src/large.ts': `export const big = "${'x'.repeat(4_000)}";\n`,
  });
  const inventory = inventoryOf(space, ['src', 'src/app.ts'], { maxFileBytes: 1_000 });
  assert.deepEqual(inventory.files.map((file) => file.relativePath), ['src/app.ts']);
  assert.equal(inventory.excluded.find((entry) => entry.relativePath === 'src/large.ts')?.reason, 'file_too_large');
});

test('a credential pattern quarantines the whole file instead of rewriting it', () => {
  const space = workspace({
    'src/app.ts': 'export const app = 1;\n',
    'src/leak.ts': 'export const key = "AKIAIOSFODNN7EXAMPLE";\nexport const rest = 2;\n',
  });
  const prepared = prepareScope(AuthorizedRoot.open(space.repositoryRoot), ['.'], { inventory: defaultOptions });
  assert.deepEqual(prepared.files.map((file) => file.snapshot.relativePath), ['src/app.ts']);
  const excluded = prepared.excluded.find((entry) => entry.relativePath === 'src/leak.ts');
  assert.equal(excluded?.reason, 'credential_pattern');
  assert.equal(excluded?.detail, 'aws_access_key_id');
  assert.ok(prepared.fragments.every((fragment) => !fragment.text.includes('AKIA')),
    'no part of a quarantined file is prepared for dispatch');
  assert.equal(exclusionCounts(prepared)['credential_pattern'], 1);
});

test('credential detection covers the documented families', () => {
  assert.equal(findCredentialPattern('-----BEGIN RSA PRIVATE KEY-----'), 'private_key_block');
  assert.equal(findCredentialPattern('const token = "ghp_0123456789012345678901234567890123456";'), 'github_token');
  assert.equal(findCredentialPattern('api_key: "0123456789abcdefghij"'), 'assigned_secret');
  assert.equal(findCredentialPattern('export const total = price * quantity;'), null);
});

test('binary content and invalid encodings are excluded, not decoded with replacements', () => {
  const space = workspace({ 'src/app.ts': 'export const app = 1;\n' });
  writeFileSync(join(space.repositoryRoot, 'src', 'binary.blob'), Buffer.from([0x41, 0x00, 0x42]));
  writeFileSync(join(space.repositoryRoot, 'src', 'latin1.data'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

  const prepared = prepareScope(AuthorizedRoot.open(space.repositoryRoot), ['.'], { inventory: defaultOptions });
  const reasons = new Map(prepared.excluded.map((entry) => [entry.relativePath, entry.reason]));
  assert.equal(reasons.get('src/binary.blob'), 'binary');
  assert.equal(reasons.get('src/latin1.data'), 'unsupported_encoding');
  assert.equal(prepared.complete, true, 'an excluded file is not an incomplete preparation');
});

test('empty and whitespace-only files get their own reasons and no fragment', () => {
  const space = workspace({
    'src/app.ts': 'export const app = 1;\n',
    'src/blank.ts': '   \n\n\t\n',
    'src/empty.ts': '',
  });
  const prepared = prepareScope(AuthorizedRoot.open(space.repositoryRoot), ['.'], { inventory: defaultOptions });
  const counts = exclusionCounts(prepared);
  assert.equal(counts['whitespace_only'], 1);
  assert.equal(counts['empty'], 1);
  assert.equal(prepared.fragments.every((fragment) => fragment.path === 'src/app.ts'), true);
});

test('a snapshot reproduces its bytes exactly, including BOM, CRLF and astral characters', () => {
  const text = '﻿const grüße = "\u{1F44B}";\r\nconst second = 2;\r\n// no final newline';
  const bytes = Buffer.from(text, 'utf8');
  const snapshot = createSnapshot('src/unicode.ts', '/tmp/src/unicode.ts', bytes, countReferenceTokens);

  assert.equal(snapshot.lineCount, 3);
  assert.equal(snapshot.hasBom, true);
  assert.equal(snapshot.endsWithNewline, false);
  assert.equal(snapshot.text, text);
  assert.equal(snapshot.sliceLines(1, 3).text, text);
  assert.equal(snapshot.sliceLines(2, 2).text, 'const second = 2;\r\n');
  assert.equal(snapshot.sliceLines(3, 3).text, '// no final newline');

  // Byte offsets and UTF-16 offsets describe the same lines.
  const slice = snapshot.sliceLines(2, 2);
  assert.equal(bytes.subarray(slice.startByte, slice.endByte).toString('utf8'), slice.text);
});

test('a terminal newline does not invent a line, and CRLF is one ending', () => {
  const snapshot = createSnapshot('a.txt', '/tmp/a.txt', Buffer.from('one\r\ntwo\n', 'utf8'), countReferenceTokens);
  assert.equal(snapshot.lineCount, 2);
  assert.equal(snapshot.isBlankLine(1), false);
  assert.equal(snapshot.sliceLines(1, 2).text, 'one\r\ntwo\n');
});

test('the snapshot hash covers the whole file, not a fragment or a transformation', () => {
  const bytes = Buffer.from('alpha\nbeta\n', 'utf8');
  const snapshot = createSnapshot('a.txt', '/tmp/a.txt', bytes, countReferenceTokens);
  const expected = '68dfae24b170a5b2ef4d1a7ffd0b9891cf6b2f0dc6ff9a1c3e2f4c8bbb1b1b09';
  assert.equal(snapshot.sha256.length, 64);
  assert.notEqual(snapshot.sha256, expected.slice(0, 64).replace(/./g, '0'));
  assert.equal(
    createSnapshot('b.txt', '/tmp/b.txt', bytes, countReferenceTokens).sha256,
    snapshot.sha256,
    'the hash depends on the bytes, not on the path',
  );
});

test('invalid UTF-8 is refused explicitly', () => {
  assert.throws(
    () => createSnapshot('a.txt', '/tmp/a.txt', Buffer.from([0xff, 0xfe, 0x41]), countReferenceTokens),
    (error: unknown) => error instanceof SnapshotError && error.refusal === 'unsupported_encoding',
  );
  assert.throws(
    () => createSnapshot('a.txt', '/tmp/a.txt', Buffer.from([0x41, 0x00]), countReferenceTokens),
    (error: unknown) => error instanceof SnapshotError && error.refusal === 'binary',
  );
});
