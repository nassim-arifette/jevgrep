import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createSearchEngine } from '../src/engine.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../src/evaluation/contracts.ts';
import type { CandidatePool } from '../src/response/candidate-pool.ts';
import { excerptCost } from '../src/response/render.ts';
import { replayPool } from '../scripts/bench/replay.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';
import { SELECTION_POLICIES, selectRanges } from '../src/response/selection.ts';
import type { Candidate, SelectionPolicy } from '../src/response/selection.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import type { PreparedFragment } from '../src/source/chunker.ts';

/**
 * Experimental selection orders (roadmap section 8). The default stays the
 * relevance walk; the others re-rank by local redundancy only and must keep every
 * budget, threshold and provenance guarantee of the default.
 */

const body = (name: string, variant: string): string[] => [
  `export function ${name}(input: Request): Response {`,
  `  const token = input.headers.get('authorization');`,
  `  if (token === null) return deny(${variant});`,
  `  return allow(token);`,
  `}`,
];

const FILES: Record<string, string> = {
  'src/auth.ts': [...body('checkAdmin', "'admin'"), ...body('checkAdminCopy', "'admin'"), ...body('checkUser', "'user'")].join('\n') + '\n',
  'src/billing.ts': ['export function invoiceTotal(lines: Line[]): number {', '  return lines.reduce((sum, line) => sum + line.amount, 0);', '}'].join('\n') + '\n',
  // One declaration longer than a window: the engine returns it whole when it fits, and a replay must do the same.
  'src/admin_table.go': `package auth\n\nfunc adminTable() []int {\n\treturn []int{\n${Array.from({ length: 150 }, (_, n) => `\t\t${String(n * 7919)},\n`).join('')}\t}\n}\n`,
};

function sliceLines(path: string, startLine: number, endLine: number): string | null {
  const text = FILES[path];
  return text === undefined ? null : text.split(/(?<=\n)/).slice(startLine - 1, endLine).join('');
}

function fragment(path: string, startLine: number, endLine: number, label: string | null = null): PreparedFragment {
  const text = sliceLines(path, startLine, endLine) ?? '';
  return {
    id: `${path}#L${String(startLine)}-L${String(endLine)}`, path, sha256: createHash('sha256').update(FILES[path] ?? '').digest('hex'),
    startLine, endLine, byteStart: 0, byteEnd: Buffer.byteLength(text), text, byteCount: Buffer.byteLength(text),
    tokenCount: countReferenceTokens(text), chunker: 'jevgrep-syntax-1', classification: 'syntax-range', label,
  };
}

const candidates: Candidate[] = [
  { fragment: fragment('src/auth.ts', 1, 5, 'checkAdmin'), score: 0.95 },
  // A near-copy of the first range in another position of the same file.
  { fragment: fragment('src/auth.ts', 6, 10, 'checkAdminCopy'), score: 0.94 },
  { fragment: fragment('src/auth.ts', 11, 15, 'checkUser'), score: 0.9 },
  { fragment: fragment('src/billing.ts', 1, 3, 'invoiceTotal'), score: 0.8 },
  { fragment: fragment('src/auth.ts', 2, 4), score: 0.7 },
  { fragment: fragment('src/billing.ts', 1, 3, 'invoiceTotal'), score: 0.3 },
];

const select = (policy: SelectionPolicy | undefined, availableTokens: number) => selectRanges(candidates, {
  threshold: 0.5, availableTokens, measure: excerptCost, sliceLines, ...(policy === undefined ? {} : { policy }),
});

test('an absent policy is exactly the relevance walk', () => {
  for (const budget of [0, 120, 200, 260, 400, 10_000]) {
    assert.deepEqual(select(undefined, budget), select('relevance', budget));
  }
});

test('every policy respects the budget, the threshold and exact source text', () => {
  for (const policy of SELECTION_POLICIES) {
    for (let budget = 0; budget <= 500; budget += 7) {
      const result = select(policy, budget);
      assert.ok(result.ranges.reduce((sum, range) => sum + excerptCost(range), 0) <= budget, `${policy} at ${String(budget)}`);
      for (const range of result.ranges) {
        assert.equal(range.text, sliceLines(range.path, range.startLine, range.endLine));
        assert.ok(range.score >= 0.5);
      }
      assert.equal(result.aboveThreshold, 5);
      assert.equal(result.belowThreshold, 1);
    }
  }
});

test('with room for everything, every policy returns the same ranges', () => {
  const ranges = (policy: SelectionPolicy) => select(policy, 10_000).ranges.map((range) => `${range.path}:${String(range.startLine)}-${String(range.endLine)}`);
  assert.deepEqual(ranges('mmr'), ranges('relevance'));
  assert.deepEqual(ranges('marginal'), ranges('relevance'));
});

test('diversity policies are deterministic and may trade a near-duplicate for another file', () => {
  const tight = excerptCost({ ...fragment('src/auth.ts', 1, 5), score: 0.95 }) * 2 + 10;
  const relevance = select('relevance', tight).ranges.map((range) => range.path);
  assert.deepEqual(relevance, ['src/auth.ts']);
  for (const policy of ['mmr', 'marginal'] as const) {
    const first = select(policy, tight);
    assert.deepEqual(select(policy, tight), first);
    assert.ok(first.ranges.some((range) => range.path === 'src/billing.ts'), `${policy} should reach the second file`);
  }
});

class FixedScores implements ProviderClient {
  readonly model = 'jev-1.13.0';
  calls = 0;

  evaluateBatch(batch: EvaluationBatch): Promise<BatchEvaluation> {
    this.calls += 1;
    // Only the first window of the long Go literal qualifies, so a whole-declaration return is visible.
    const scores = new Map(batch.items.map((item) => [item.id, item.path === 'src/billing.ts' ? 0.6
      : item.path === 'src/admin_table.go' ? (item.startLine === 4 ? 0.9 : 0.4) : 0.9]));
    return Promise.resolve({
      scores, invalid: [], usage: { inputTokens: 1_000, outputTokens: 0 }, requestedModel: this.model,
      returnedModel: this.model, transmittedBytes: 4_096, requestId: 'req-test',
    });
  }
}

test('a captured pool replays offline to the identical live response, and other arms need no provider', async (t) => {
  const space = createWorkspace({ files: FILES, configure: withRemoteEnabled });
  t.after(() => { space.cleanup(); });
  const provider = new FixedScores();
  const pools: CandidatePool[] = [];
  const live = await createSearchEngine({ configuration: space.loaded, provider, env: space.env }).search(
    { query: 'where is the admin authorization check?', scope: ['.'], max_context_tokens: 4_000 },
    { searchId: 'replay-1', onCandidatePool: (pool) => { pools.push(pool); } },
  );
  assert.equal(pools.length, 1);
  const pool = pools[0]!;
  assert.ok(pool.candidates.length > 0);
  assert.ok(!('text' in pool.candidates[0]!), 'pools carry ranges and scores, never source text');
  assert.ok(pool.candidates.some((candidate) => candidate.path === 'src/admin_table.go' && candidate.declaration != null), 'split windows keep their declaration');
  const calls = provider.calls;
  assert.deepEqual(replayPool(pool, FILES, { policy: 'relevance' }).result, live.outcome);
  assert.notDeepEqual(replayPool(pool, FILES, { policy: 'relevance', wholeDeclarations: false }).result.excerpts, live.outcome.status === 'complete' ? live.outcome.excerpts : []);
  for (const policy of SELECTION_POLICIES) {
    for (const requestedTokens of [1_200, 2_000, 4_000]) {
      const { result, measuredTokens } = replayPool(pool, FILES, { policy, requestedTokens });
      assert.ok(measuredTokens <= requestedTokens);
      assert.equal(result.status, 'complete');
    }
  }
  assert.equal(provider.calls, calls);
  assert.throws(() => replayPool(pool, { ...FILES, 'src/auth.ts': `${FILES['src/auth.ts']!}// edited\n` }, { policy: 'relevance' }), /does not match the captured snapshot/);
});
