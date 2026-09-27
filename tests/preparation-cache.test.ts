import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { SearchProfiler } from '../src/profiling.ts';
import { AuthorizedRoot } from '../src/source/authorization.ts';
import { DEFAULT_WINDOW_LIMITS, SYNTAX_CHUNKER_VERSIONS, chunkerIdentityFor } from '../src/source/chunker.ts';
import type { WindowLimits } from '../src/source/chunker.ts';
import { PreparationCache, decodeLineTokens, encodeLineTokens } from '../src/source/preparation-cache.ts';
import { prepareScope } from '../src/source/prepare.ts';
import type { PreparedScope } from '../src/source/prepare.ts';
import { SCANNER_VERSION } from '../src/source/prepare.ts';
import { hashBytes } from '../src/source/snapshot.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const cleanup of cleanups) cleanup(); });

function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jevgrep-prep-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'preparation');
}

function workspace(files: Record<string, string>) {
  const space = createWorkspace({ files });
  cleanups.push(() => space.cleanup());
  return space;
}

const files = {
  'src/a.ts': Array.from({ length: 40 }, (_, n) => `export function f${n}(x: number): number {\n  return x + ${n};\n}\n`).join('\n'),
  'src/b.py': Array.from({ length: 30 }, (_, n) => `def g${n}(x):\n    return x * ${n}\n`).join('\n'),
  'src/c.md': '# Title\r\n\r\nSome \u00e9t\u00e9 text with a BOM-free body.\r\n',
  'src/bom.ts': '\ufeffexport const bom = 1;\n',
  'src/blank.ts': '   \n\n',
  'src/leak.ts': 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n',
};

type Run = { prepared: PreparedScope; profile: ReturnType<SearchProfiler['snapshot']> };

async function prepare(root: string, cache?: PreparationCache, options: { deny?: string[]; limits?: WindowLimits } = {}): Promise<Run> {
  const profiler = new SearchProfiler();
  let prepared: PreparedScope | undefined;
  await profiler.run(async () => {
    prepared = prepareScope(AuthorizedRoot.open(root), ['.'], {
      inventory: { respectGitignore: true, maxFileBytes: 1_048_576, extraDenyGlobs: options.deny ?? [] },
      ...(options.limits === undefined ? {} : { windowLimits: options.limits }),
      ...(cache === undefined ? {} : { cache }),
    });
  });
  return { prepared: prepared!, profile: profiler.snapshot() };
}

function observable(prepared: PreparedScope) {
  return {
    fragments: prepared.fragments,
    excluded: prepared.excluded,
    files: prepared.files.map((file) => [file.snapshot.relativePath, file.snapshot.sha256, file.strategy, file.parseFallback]),
    complete: prepared.complete,
    preparedBytes: prepared.preparedBytes,
  };
}

const calls = (run: Run, stage: 'chunking' | 'secret_scan' | 'decode' | 'tokenization'): number => run.profile.stages[stage]?.calls ?? 0;

test('cold and warm cached preparation equal uncached preparation exactly', async () => {
  const space = workspace(files);
  const reference = await prepare(space.repositoryRoot);
  const cache = new PreparationCache({ directory: cacheDirectory(), enabled: true, maxBytes: 10_000_000 });
  const cold = await prepare(space.repositoryRoot, cache);
  const warm = await prepare(space.repositoryRoot, cache);
  assert.deepEqual(observable(cold.prepared), observable(reference.prepared));
  assert.deepEqual(observable(warm.prepared), observable(reference.prepared));
  assert.ok(calls(cold, 'chunking') > 0);
  assert.equal(calls(warm, 'chunking'), 0);
  assert.equal(calls(warm, 'secret_scan'), reference.prepared.files.length);
  assert.equal(warm.profile.counters['preparation_cache_chunks_reused'], reference.prepared.files.length);
});

test('a new process reuses persisted entries, and they contain no source text', async () => {
  const space = workspace(files);
  const directory = cacheDirectory();
  const reference = await prepare(space.repositoryRoot);
  await prepare(space.repositoryRoot, new PreparationCache({ directory, enabled: true, maxBytes: 10_000_000 }));
  const fresh = new PreparationCache({ directory, enabled: true, maxBytes: 10_000_000 });
  const warm = await prepare(space.repositoryRoot, fresh);
  assert.deepEqual(observable(warm.prepared), observable(reference.prepared));
  assert.equal(calls(warm, 'chunking'), 0);
  assert.equal(fresh.stats.misses, 0);
  for (const shard of readdirSync(directory).filter((name) => /^[a-f0-9]{2}$/.test(name))) {
    for (const name of readdirSync(join(directory, shard))) {
      const raw = String(readFileSync(join(directory, shard, name)));
      assert.ok(!raw.includes('export function') && !raw.includes('ghp_') && !raw.includes('return x'));
    }
  }
});

test('additions, modifications and deletions are handled per file', async () => {
  const space = workspace(files);
  const cache = new PreparationCache({ directory: cacheDirectory(), enabled: true, maxBytes: 10_000_000 });
  await prepare(space.repositoryRoot, cache);
  space.write('src/new.ts', 'export const added = 1;\n');
  space.write('src/a.ts', files['src/a.ts'].replace('x + 3;', 'x + 33;'));
  space.remove('src/b.py');
  const reference = await prepare(space.repositoryRoot);
  const edited = await prepare(space.repositoryRoot, cache);
  assert.deepEqual(observable(edited.prepared), observable(reference.prepared));
  assert.equal(calls(edited, 'chunking'), 2);
  assert.equal(edited.profile.counters['preparation_cache_chunks_reused'], 2);
});

test('content verdicts are reused by hash and scanner version; eligibility is always recomputed', async () => {
  const space = workspace(files);
  const cache = new PreparationCache({ directory: cacheDirectory(), enabled: true, maxBytes: 10_000_000 });
  await prepare(space.repositoryRoot, cache);
  const warm = await prepare(space.repositoryRoot, cache);
  assert.deepEqual(warm.prepared.excluded.map((item) => [item.relativePath, item.reason, item.detail]).sort(), [
    ['src/blank.ts', 'whitespace_only', undefined], ['src/leak.ts', 'credential_pattern', 'github_token'],
  ]);
  // Content with a cached exclusion verdict is not decoded again.
  assert.equal(calls(warm, 'decode'), warm.prepared.files.length);

  const denied = await prepare(space.repositoryRoot, cache, { deny: ['**/*.py'] });
  assert.ok(!denied.prepared.files.some((file) => file.snapshot.relativePath === 'src/b.py'));
  assert.equal(calls(denied, 'chunking'), 0);
  const allowed = await prepare(space.repositoryRoot, cache);
  assert.ok(allowed.prepared.files.some((file) => file.snapshot.relativePath === 'src/b.py'));

  const sha = hashBytes(Buffer.from(files['src/leak.ts']));
  const entry = cache.get(sha, Buffer.byteLength(files['src/leak.ts']));
  entry.scan = { version: 'older-scanner', verdict: 'whitespace_only', detail: null };
  cache.update(entry);
  const rescanned = await prepare(space.repositoryRoot, cache);
  assert.ok(rescanned.prepared.excluded.some((item) => item.relativePath === 'src/leak.ts' && item.reason === 'credential_pattern'));

  entry.scan = { version: SCANNER_VERSION, verdict: 'ok', detail: null };
  cache.update(entry);
  const forged = await prepare(space.repositoryRoot, cache);
  assert.ok(forged.prepared.excluded.some((item) => item.relativePath === 'src/leak.ts' && item.reason === 'credential_pattern'));
  assert.ok(!forged.prepared.fragments.some((fragment) => fragment.text.includes('ghp_')));
});

test('a limits change rechunks without remeasuring cached line tokens', async () => {
  const space = workspace(files);
  const cache = new PreparationCache({ directory: cacheDirectory(), enabled: true, maxBytes: 10_000_000 });
  await prepare(space.repositoryRoot, cache);
  const limits = { ...DEFAULT_WINDOW_LIMITS, targetLines: 20, maxLines: 30 };
  const reference = await prepare(space.repositoryRoot, undefined, { limits });
  const changed = await prepare(space.repositoryRoot, cache, { limits });
  assert.deepEqual(observable(changed.prepared), observable(reference.prepared));
  assert.ok(calls(changed, 'chunking') > 0);
  assert.ok((changed.profile.counters['preparation_cache_chunks_reused'] ?? 0) === 0);
  assert.ok(calls(changed, 'tokenization') < calls(reference, 'tokenization'));
});

test('corrupt, mismatched and unreadable entries are rebuildable misses', async () => {
  const space = workspace(files);
  const directory = cacheDirectory();
  const reference = await prepare(space.repositoryRoot);
  await prepare(space.repositoryRoot, new PreparationCache({ directory, enabled: true, maxBytes: 10_000_000 }));
  const shaA = hashBytes(Buffer.from(files['src/a.ts']));
  const shaB = hashBytes(Buffer.from(files['src/b.py']));
  writeFileSync(join(directory, shaA.slice(0, 2), `${shaA}.json`), '{"schema_version":1,');
  const pathB = join(directory, shaB.slice(0, 2), `${shaB}.json`);
  const entryB = JSON.parse(String(readFileSync(pathB))) as { chunks: Record<string, unknown> };
  for (const record of Object.values(entryB.chunks) as { fragments: number[][] }[]) record.fragments[0]![1] = 10_000;
  writeFileSync(pathB, JSON.stringify(entryB));
  const cache = new PreparationCache({ directory, enabled: true, maxBytes: 10_000_000 });
  const recovered = await prepare(space.repositoryRoot, cache);
  assert.deepEqual(observable(recovered.prepared), observable(reference.prepared));
  assert.equal(cache.stats.corrupt, 2);
  const again = new PreparationCache({ directory, enabled: true, maxBytes: 10_000_000 });
  const rebuilt = await prepare(space.repositoryRoot, again);
  assert.equal(calls(rebuilt, 'chunking'), 0);
  assert.equal(again.stats.corrupt, 0);

  const unusable = join(cacheDirectory(), 'file');
  mkdirSync(join(unusable, '..'), { recursive: true });
  writeFileSync(unusable, 'not a directory');
  const broken = await prepare(space.repositoryRoot, new PreparationCache({ directory: join(unusable, 'child'), enabled: true, maxBytes: 1_000 }));
  assert.deepEqual(observable(broken.prepared), observable(reference.prepared));
});

test('storage stays within its byte bound, evicting oldest entries first', async () => {
  const space = workspace(files);
  const directory = cacheDirectory();
  const maxBytes = 3_000;
  const cache = new PreparationCache({ directory, enabled: true, maxBytes });
  await prepare(space.repositoryRoot, cache);
  let total = 0;
  for (const shard of readdirSync(directory).filter((name) => /^[a-f0-9]{2}$/.test(name))) {
    for (const name of readdirSync(join(directory, shard))) total += statSync(join(directory, shard, name)).size;
  }
  assert.ok(total <= maxBytes, `stored ${String(total)} bytes`);
  assert.ok(cache.stats.evicted > 0);
});

test('clear removes stored entries and never creates a missing store', async () => {
  const space = workspace(files);
  const directory = cacheDirectory();
  const open = (): PreparationCache => new PreparationCache({ directory, enabled: true, maxBytes: 10_000_000 });
  assert.equal(open().clear(), 0);
  assert.throws(() => readdirSync(directory));
  await prepare(space.repositoryRoot, open());
  const cleared = open();
  assert.ok(cleared.clear() > 0);
  assert.equal(cleared.stats.failures, 0);
  assert.ok(calls(await prepare(space.repositoryRoot, open()), 'chunking') > 0, 'nothing is reused after a clear');
});

test('a disabled cache does no work and stores nothing', async () => {
  const space = workspace(files);
  const directory = cacheDirectory();
  const cache = new PreparationCache({ directory, enabled: false, maxBytes: 10_000_000 });
  const reference = await prepare(space.repositoryRoot);
  const run = await prepare(space.repositoryRoot, cache);
  assert.deepEqual(observable(run.prepared), observable(reference.prepared));
  assert.equal(cache.stats.hits + cache.stats.misses + cache.stats.writes, 0);
  assert.throws(() => readdirSync(directory));
});

test('identical bytes under different extensions or chunkers never share fragments', async () => {
  const body = 'export const view = (x: number) => x + 1;\nexport function other() {\n  return 2;\n}\n';
  const space = workspace({ 'src/a.ts': body, 'src/b.tsx': body, 'src/c.md': body });
  const cache = new PreparationCache({ directory: cacheDirectory(), enabled: true, maxBytes: 10_000_000 });
  const reference = await prepare(space.repositoryRoot);
  const cached = await prepare(space.repositoryRoot, cache);
  assert.deepEqual(observable(cached.prepared), observable(reference.prepared));
  const entry = cache.get(hashBytes(Buffer.from(body)), Buffer.byteLength(body));
  assert.equal(Object.keys(entry.chunks).length, 3);
});

test('line tokens persist little-endian on every host', () => {
  const values = Int32Array.of(1, -1, 256);
  const encoded = encodeLineTokens(values);
  assert.equal(encoded, Buffer.from([1, 0, 0, 0, 255, 255, 255, 255, 0, 1, 0, 0]).toString('base64'));
  assert.deepEqual(decodeLineTokens(encoded), values);
});

test('each syntax language keys its chunks by its own chunker version', () => {
  // A bump of one language's boundaries must not reuse that language's cached fragments.
  assert.ok(chunkerIdentityFor('src/a.ts').includes(SYNTAX_CHUNKER_VERSIONS.javascript));
  assert.ok(chunkerIdentityFor('src/a.py').includes(SYNTAX_CHUNKER_VERSIONS.python));
  assert.ok(chunkerIdentityFor('src/A.java').includes(SYNTAX_CHUNKER_VERSIONS.java));
  assert.ok(!chunkerIdentityFor('src/a.py').includes(SYNTAX_CHUNKER_VERSIONS.javascript));
  assert.ok(!chunkerIdentityFor('src/A.java').includes(SYNTAX_CHUNKER_VERSIONS.javascript));
});

test('cached token counts that cannot match their bytes are rebuilt', async () => {
  const space = workspace({ 'src/a.ts': files['src/a.ts'] });
  const cache = new PreparationCache({ directory: cacheDirectory(), enabled: true, maxBytes: 10_000_000 });
  const reference = await prepare(space.repositoryRoot);
  await prepare(space.repositoryRoot, cache);
  const entry = cache.get(hashBytes(Buffer.from(files['src/a.ts'])), Buffer.byteLength(files['src/a.ts']));
  for (const record of Object.values(entry.chunks)) {
    if (record.kind === 'fragments') Object.assign(record, { fragments: [[record.fragments[0]![0], record.fragments[0]![1], 0], ...record.fragments.slice(1)] });
  }
  cache.update(entry);
  const run = await prepare(space.repositoryRoot, cache);
  assert.deepEqual(observable(run.prepared), observable(reference.prepared));
  assert.equal(cache.stats.corrupt, 1);
  assert.equal(calls(await prepare(space.repositoryRoot, cache), 'chunking'), 0);
});

test('entries pending while another writer holds the lock are retried on the next flush', async () => {
  const space = workspace({ 'src/a.ts': files['src/a.ts'] });
  const directory = cacheDirectory();
  const cache = new PreparationCache({ directory, enabled: true, maxBytes: 10_000_000 });
  const lock = join(directory, '.write.lock');
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, 'a'), '');
  writeFileSync(join(lock, 'b'), '');
  await prepare(space.repositoryRoot, cache);
  assert.equal(cache.stats.writes, 0);
  rmSync(lock, { recursive: true, force: true });
  assert.equal(cache.flush(), 1);
});
