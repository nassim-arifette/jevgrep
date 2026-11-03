import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSearchEngine } from '../src/engine.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../src/evaluation/contracts.ts';
import { serializeConfiguredBatch } from '../src/evaluation/provider.ts';
import type { CandidatePool } from '../src/response/candidate-pool.ts';
import { PoolProvider, lexicalFiles, mentionedFiles, preparedPaths } from '../scripts/bench/candidates.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

/**
 * First-stage candidate suppliers for roadmap section 9. They only rank files the
 * authorized scan prepared, and a scoped search over their output must receive the
 * full scan's own Jev judgments without a provider request.
 */

const FILES: Record<string, string> = {
  'src/cache/invalidate.ts': 'export function invalidateCache(key: string): void {\n  cacheStore.delete(key);\n}\n',
  'src/cache/store.ts': 'export const cacheStore = new Map<string, string>();\n',
  'src/http/client.ts': 'export async function fetchJson(url: string): Promise<unknown> {\n  return (await fetch(url)).json();\n}\n',
  'lib/client.ts': 'export const retries = 3;\n',
};
const PATHS = Object.keys(FILES).sort();

test('lexical candidates rank prepared files by BM25 and respect the list size', () => {
  assert.deepEqual(lexicalFiles('show the passages explaining cache invalidation', FILES, PATHS, 1), ['src/cache/invalidate.ts']);
  assert.deepEqual(lexicalFiles('cache', FILES, PATHS, 10).sort(), ['src/cache/invalidate.ts', 'src/cache/store.ts']);
  assert.deepEqual(lexicalFiles('cache', FILES, ['src/http/client.ts'], 10), [], 'never proposes a file outside the prepared list');
  assert.deepEqual(lexicalFiles('unrelated words', FILES, PATHS, 10), []);
});

test('mentioned paths resolve to prepared files and leave ambiguous names unresolved', () => {
  assert.deepEqual(mentionedFiles('What does src/cache/store.ts export?', PATHS), ['src/cache/store.ts']);
  assert.deepEqual(mentionedFiles('Look at ./cache/invalidate.ts and store.ts', PATHS), ['src/cache/invalidate.ts', 'src/cache/store.ts']);
  assert.deepEqual(mentionedFiles('Why does client.ts retry?', PATHS), [], 'two files are named client.ts');
  assert.deepEqual(mentionedFiles('Read secrets/other.ts', PATHS), []);
});

class FixedScores implements ProviderClient {
  readonly model = 'jev-1.13.0';
  calls = 0;

  evaluateBatch(batch: EvaluationBatch): Promise<BatchEvaluation> {
    this.calls += 1;
    const scores = new Map(batch.items.map((item) => [item.id, item.path.startsWith('src/cache/') ? 0.9 : 0.2]));
    return Promise.resolve({
      scores, invalid: [], usage: { inputTokens: 1_000, outputTokens: 0 }, requestedModel: this.model,
      returnedModel: this.model, transmittedBytes: 4_096, requestId: 'req-test',
    });
  }
}

test('a scoped search over supplied files receives the full scan judgments without provider requests', async (t) => {
  // The score cache is off so the scoped search cannot reuse the full scan's entries.
  const space = createWorkspace({ files: FILES, configure: (config) => ({ ...withRemoteEnabled(config), cache: { ...config.cache, enabled: false } }) });
  t.after(() => { space.cleanup(); });
  const query = { query: 'show the passages explaining cache invalidation', max_context_tokens: 4_000 };
  const live = new FixedScores();
  let pool: CandidatePool | null = null;
  const full = await createSearchEngine({ configuration: space.loaded, provider: live, env: space.env }).search(
    { ...query, scope: ['.'] }, { searchId: 'full', onCandidatePool: (captured) => { pool = captured; } },
  );
  assert.ok(pool !== null && 'excerpts' in full.outcome);
  const captured: CandidatePool = pool;
  assert.deepEqual(preparedPaths(captured), PATHS);

  const supplied = lexicalFiles(query.query, FILES, preparedPaths(captured), 1);
  const replay = new PoolProvider(captured, live.model, (batch) => serializeConfiguredBatch(space.loaded.config, batch));
  const scoped = await createSearchEngine({ configuration: space.loaded, provider: replay, env: space.env }).search(
    { ...query, scope: supplied }, { searchId: 'scoped' },
  );
  assert.equal(live.calls > 0, true);
  const calls = live.calls;
  assert.ok('excerpts' in scoped.outcome);
  assert.equal(scoped.outcome.status, 'complete');
  assert.ok(scoped.outcome.excerpts.length > 0);
  for (const excerpt of scoped.outcome.excerpts) {
    assert.ok(supplied.includes(excerpt.path));
    const original = captured.candidates.find((candidate) => candidate.path === excerpt.path && candidate.startLine === excerpt.start_line);
    assert.equal(excerpt.score, original?.score);
  }
  assert.deepEqual(scoped.outcome.excerpts.map((excerpt) => excerpt.path), full.outcome.excerpts.filter((excerpt) => supplied.includes(excerpt.path)).map((excerpt) => excerpt.path));
  assert.equal(live.calls, calls, 'the scoped search never reached the live provider');
  assert.ok(replay.requests > 0);
});

test('the replay provider refuses a fragment the full scan never evaluated', async () => {
  const pool = { candidates: [{ path: 'a.ts', startLine: 1, endLine: 2, score: 0.5 }] } as unknown as CandidatePool;
  const replay = new PoolProvider(pool, 'jev', () => '{}');
  const item = (startLine: number) => ({ id: 'x', path: 'a.ts', startLine, endLine: 2 });
  const batch = (startLine: number) => ({ items: [item(startLine)] }) as unknown as EvaluationBatch;
  assert.equal((await replay.evaluateBatch(batch(1))).scores.get('x'), 0.5);
  assert.throws(() => replay.evaluateBatch(batch(2)), /was not evaluated by the captured full scan/);
});
