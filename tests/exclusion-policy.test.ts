import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/contracts.ts';
import { AuthorizedRoot } from '../src/source/authorization.ts';
import { inventoryScope } from '../src/source/inventory.ts';
import type { InventoryOptions } from '../src/source/inventory.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

const options: InventoryOptions = {
  respectGitignore: true, maxFileBytes: 1_048_576, extraDenyGlobs: ['src/operator/**'],
};
const files = {
  '.gitignore': 'ignored/\nsrc/parent/\n',
  '.jevgrepignore': 'private/\nsrc/narrowed.txt\n',
  'src/.gitignore': '!narrowed.txt\n',
  'src/narrowed.txt': 'excluded harmless source\n',
  'src/operator/deep/note.txt': 'operator excluded harmless source\n',
  'src/parent/.gitignore': '!note.txt\n',
  'src/parent/note.txt': 'ignored parent harmless source\n',
  'private/deep/note.txt': 'narrowing excluded harmless source\n',
  'ignored/note.txt': 'git excluded harmless source\n',
  'src/node_modules/pkg/note.txt': 'dependency harmless source\n',
  'src/secrets/note.txt': 'credential directory harmless source\n',
  'src/dist/note.txt': 'build output harmless source\n',
  'src/generated/note.txt': 'generated harmless source\n',
  'src/.git/note.txt': 'administrative harmless source\n',
  'src/keep.txt': 'eligible harmless source\n',
};

const excludedPaths = Object.keys(files).filter((path) => path.endsWith('note.txt') || path.endsWith('narrowed.txt'));

test('narrowing a scope cannot reopen excluded files or their directories', () => {
  const space = createWorkspace({ files });
  try {
    const root = AuthorizedRoot.open(space.repositoryRoot);
    const baseline = new Set(inventoryScope(root, ['.'], options).files.map((file) => file.relativePath));
    assert.equal(baseline.has('src/keep.txt'), true);
    for (const path of excludedPaths) {
      assert.equal(baseline.has(path), false, path);
      const segments = path.split('/');
      const scopes = [path, ...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))];
      for (const scope of scopes) {
        const narrowed = inventoryScope(root, [scope], options);
        assert.equal(narrowed.complete, true, scope);
        assert.ok(narrowed.files.every((file) => baseline.has(file.relativePath)), scope);
        assert.equal(narrowed.files.some((file) => file.relativePath === path), false, scope);
      }
    }
  } finally { space.cleanup(); }
});

test('Git negations cannot undo root or nested JevGrep exclusions', () => {
  const space = createWorkspace({ files: {
    '.jevgrepignore': 'src/root.txt\n',
    'src/.jevgrepignore': 'nested.txt\n',
    'src/.gitignore': '!root.txt\n!nested.txt\n!deep/\n',
    'src/root.txt': 'root excluded\n', 'src/nested.txt': 'nested excluded\n',
    'src/deep/.gitignore': '!note.txt\n', 'src/deep/note.txt': 'still excluded\n',
    'src/deep/.jevgrepignore': 'note.txt\n',
  } });
  try {
    const root = AuthorizedRoot.open(space.repositoryRoot);
    for (const scope of [['.'], ['src'], ['src/root.txt', 'src/nested.txt', 'src/deep/note.txt']]) {
      const result = inventoryScope(root, scope, options);
      assert.ok(result.files.every((file) => !file.relativePath.endsWith('.txt')));
      assert.ok(result.excluded.filter((entry) => entry.relativePath.endsWith('.txt'))
        .every((entry) => entry.reason === 'jevgrepignored'));
    }
  } finally { space.cleanup(); }
});

test('excluded explicit scopes never reach provider dispatch', async () => {
  const space = createWorkspace({ files, configure: (config) => ({
    ...withRemoteEnabled(config), source: { ...config.source, extra_deny_globs: [...options.extraDenyGlobs] },
  }) });
  const seen: string[] = [];
  const provider: ProviderClient = {
    model: 'jev-1.13.0',
    async evaluateBatch(batch) {
      seen.push(...batch.items.map((item) => item.path));
      return {
        scores: new Map(batch.items.map((item) => [item.id, 0.9])), invalid: [],
        usage: { inputTokens: 1, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
        transmittedBytes: 0, requestId: null,
      };
    },
  };
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider });
    const result = (await engine.search({ query: 'harmless source', scope: [...excludedPaths, 'src/keep.txt'] })).outcome;
    assert.ok('report' in result);
    assert.deepEqual(seen, ['src/keep.txt']);
  } finally { space.cleanup(); }
});

test('directory exclusion and supported Git negations agree with git check-ignore for every scope', () => {
  const gitFiles = {
    '.gitignore': 'hidden/\n*.tmp\n!keep.tmp\n/root.txt\n',
    'hidden/.gitignore': '!note.txt\n', 'hidden/note.txt': 'hidden\n',
    'drop.tmp': 'drop\n', 'keep.tmp': 'keep\n', 'root.txt': 'root\n',
    'src/.gitignore': '*.txt\n!keep.txt\n', 'src/drop.txt': 'drop\n', 'src/keep.txt': 'keep\n',
    'src/root.txt': 'nested\n', 'src/app.ts': 'keep\n',
  };
  const space = createWorkspace({ files: gitFiles });
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: space.repositoryRoot });
    const paths = Object.keys(gitFiles).filter((path) => !path.endsWith('.gitignore'));
    const ignored = new Set(execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: space.repositoryRoot, input: `${paths.join('\n')}\n`, encoding: 'utf8',
    }).trim().split('\n'));
    const root = AuthorizedRoot.open(space.repositoryRoot);
    for (const path of paths) {
      for (const scope of [['.'], [path]]) {
        const eligible = inventoryScope(root, scope, options).files.some((file) => file.relativePath === path);
        assert.equal(eligible, !ignored.has(path), `${scope.join(',')} -> ${path}`);
      }
    }
  } finally { space.cleanup(); }
});
