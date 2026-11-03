import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createDefaultConfiguration } from '../src/config.ts';
import { adjacentCandidates, expandCandidates, loadCodeGraph, type CodeGraph, type GraphNode } from '../scripts/bench/graph.ts';
import { candidateCost, itemHash, itemKey, replayProvider, sha256, type PoolItem, type PoolQuery, type ScorePool } from '../scripts/bench/score-pool.ts';

const item = (path: string, startLine: number, endLine: number, score: number | null = 0.5): PoolItem =>
  ({ path, startLine, endLine, sha256: itemHash({ text: `${path}:${startLine}`, label: null }), score, tokens: 100 });
const node = (id: string, path: string, startLine: number, endLine: number, kind = 'function'): GraphNode =>
  ({ id, kind, name: id, qualifiedName: id, path, startLine, endLine });

function graph(nodes: GraphNode[], edges: [string, string][]): CodeGraph {
  const byFile = new Map<string, GraphNode[]>();
  for (const entry of nodes) (byFile.get(entry.path) ?? byFile.set(entry.path, []).get(entry.path)!).push(entry);
  const adjacent = new Map<string, { id: string; kind: string }[]>();
  for (const [a, b] of edges) {
    (adjacent.get(a) ?? adjacent.set(a, []).get(a)!).push({ id: b, kind: 'calls' });
    (adjacent.get(b) ?? adjacent.set(b, []).get(b)!).push({ id: a, kind: 'calls' });
  }
  return { nodes: new Map(nodes.map((entry) => [entry.id, entry])), byFile, adjacent, stats: { nodes: nodes.length, edges: edges.length, unresolved: 0 } };
}

// a.py:f calls b.py:g, g calls c.py:h, h calls f again (a cycle); lexical order puts the related code last.
const fragments = [item('a.py', 1, 5), item('z.py', 1, 5), item('z.py', 6, 10), item('z.py', 11, 15), item('b.py', 1, 5), item('c.py', 1, 5)];
const cycle = graph([node('f', 'a.py', 1, 5), node('g', 'b.py', 1, 5), node('h', 'c.py', 1, 5)], [['f', 'g'], ['g', 'h'], ['h', 'f']]);

test('expansion keeps the fixed lexical seeds and the same allowance for every hop count', () => {
  for (const hops of [0, 1, 2] as const) {
    const chosen = expandCandidates(fragments, cycle, { budget: 4, seeds: 1, hops, fanout: 4 });
    assert.equal(chosen.length, 4);
    assert.equal(chosen[0]!.item, fragments[0]);
    assert.equal(new Set(chosen.map((entry) => entry.item)).size, 4, 'no fragment is evaluated twice');
  }
  assert.deepEqual(expandCandidates(fragments, cycle, { budget: 4, seeds: 1, hops: 0, fanout: 4 }).map((entry) => entry.origin), ['seed', 'seed', 'seed', 'seed']);
});

test('one hop follows direct relations in both directions; cycles terminate and visited symbols are not revisited', () => {
  const one = expandCandidates(fragments, cycle, { budget: 6, seeds: 1, hops: 1, fanout: 4 });
  assert.deepEqual(one.slice(0, 3).map((entry) => [entry.item.path, entry.origin]), [['a.py', 'seed'], ['b.py', 'hop1'], ['c.py', 'hop1']]);
  const chain = graph([node('f', 'a.py', 1, 5), node('g', 'b.py', 1, 5), node('h', 'c.py', 1, 5)], [['f', 'g'], ['g', 'h']]);
  const two = expandCandidates(fragments, chain, { budget: 3, seeds: 1, hops: 2, fanout: 4 });
  assert.deepEqual(two.map((entry) => [entry.item.path, entry.origin]), [['a.py', 'seed'], ['b.py', 'hop1'], ['c.py', 'hop2']]);
  assert.deepEqual(expandCandidates(fragments, chain, { budget: 3, seeds: 1, hops: 1, fanout: 4 }).map((entry) => entry.origin), ['seed', 'hop1', 'lexical']);
});

test('a missing graph or a missing edge falls back to the lexical ranking instead of dropping candidates', () => {
  const fallback = expandCandidates(fragments, null, { budget: 3, seeds: 1, hops: 2, fanout: 4 });
  assert.deepEqual(fallback.map((entry) => entry.item), fragments.slice(0, 3));
  const isolated = expandCandidates(fragments, graph([node('f', 'a.py', 1, 5)], []), { budget: 3, seeds: 1, hops: 2, fanout: 4 });
  assert.deepEqual(isolated.map((entry) => entry.origin), ['seed', 'lexical', 'lexical']);
  // A stale edge to a symbol with no current fragment proposes nothing and costs no allowance.
  const stale = expandCandidates(fragments, graph([node('f', 'a.py', 1, 5), node('gone', 'deleted.py', 1, 9)], [['f', 'gone']]),
    { budget: 2, seeds: 1, hops: 1, fanout: 4 });
  assert.deepEqual(stale.map((entry) => entry.item.path), ['a.py', 'z.py']);
});

test('the locality control expands to file neighbors under the same allowance', () => {
  const chosen = adjacentCandidates([fragments[2]!, ...fragments.filter((entry) => entry !== fragments[2])], { budget: 4, seeds: 1 });
  assert.deepEqual(chosen.map((entry) => [entry.item.startLine, entry.origin]), [[6, 'seed'], [1, 'adjacent'], [11, 'adjacent'], [1, 'lexical']]);
});

test('the CodeGraph reader is read-only, follows relations only and skips unresolved module stubs', () => {
  const root = mkdtempSync(join(tmpdir(), 'jevgrep-graph-'));
  try {
    const path = join(root, 'codegraph.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, start_line INT, end_line INT);
      CREATE TABLE edges (source TEXT, target TEXT, kind TEXT); CREATE TABLE unresolved_refs (id TEXT);
      INSERT INTO nodes VALUES ('f','function','f','m.f','a.py',1,5), ('g','method','g','m.C.g','b.py',3,9), ('i','import','os','os','a.py',1,1), ('x','file','a.py','a.py','a.py',1,40);
      INSERT INTO edges VALUES ('f','g','calls'), ('f','i','imports'), ('x','f','contains');
      INSERT INTO unresolved_refs VALUES ('u1'), ('u2');`);
    db.close();
    const loaded = loadCodeGraph(path);
    assert.deepEqual(loaded.stats, { nodes: 4, edges: 1, unresolved: 2 });
    assert.deepEqual(loaded.adjacent.get('g'), [{ id: 'f', kind: 'calls' }]);
    assert.equal(loaded.adjacent.get('x'), undefined, 'structural containment is not a relation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('replay masks non-candidates to zero, never invents a missing score and keeps Jev cost to the candidate set', async () => {
  const config = createDefaultConfiguration('/', 'jev-1.13.0');
  const query = 'where is f?';
  const kept = { ...item('a.py', 1, 5, 0.9), sha256: itemHash({ text: 'def f(): pass', label: 'f' }) };
  const unscored = { ...item('b.py', 1, 5, null), sha256: itemHash({ text: 'def g(): pass', label: null }) };
  const entry: PoolQuery = { questionSha256: sha256(query), items: [kept, unscored], questionTokens: 50, requests: 1, reportedInputTokens: 250, unknownUsage: 0, providerMs: 100, answeredModels: [] };
  const pool: ScorePool = { schemaVersion: 1, createdAt: '', provider: config.provider, search: config.search, queries: { q: entry } };
  const { provider, account } = replayProvider(pool, entry, config, new Set([itemKey(kept), itemKey(unscored)]));
  const result = await provider.evaluateBatch({ query, items: [
    { id: '1', path: 'a.py', startLine: 1, endLine: 5, text: 'def f(): pass', label: 'f' },
    { id: '2', path: 'b.py', startLine: 1, endLine: 5, text: 'def g(): pass', label: null },
    { id: '3', path: 'c.py', startLine: 1, endLine: 5, text: 'def h(): pass', label: null },
  ] });
  assert.deepEqual([...result.scores], [['1', 0.9], ['3', 0]]);
  assert.deepEqual(account, { requests: 1, missing: 1, masked: 1, evaluated: 1 });
  await assert.rejects(provider.evaluateBatch({ query: 'edited', items: [] }), /differs/);
  assert.deepEqual(candidateCost(entry, [kept, unscored]), { batches: 1, tokens: 250 });
  assert.deepEqual(candidateCost(entry, Array.from({ length: 65 }, () => kept)), { batches: 2, tokens: 65 * 100 + 2 * 50 });
});
