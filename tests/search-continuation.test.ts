import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/contracts.ts';
import type { SearchError, SearchResult } from '../src/contracts.ts';
import { encodeContinuation, MAX_DELIVERED_FRAGMENTS } from '../src/continuation.ts';
import { renderHumanOutcome } from '../src/cli-render.ts';
import { referenceCounter } from '../src/response/token-counter.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

const files = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
  `src/file-${String(index).padStart(2, '0')}.ts`, `export const invalidate${String(index)} = ${String(index)};\n`,
]));

function countingProvider(scoreOf: (path: string) => number = () => 0.9): ProviderClient & { calls: number } {
  return {
    model: 'jev-1.13.0', calls: 0,
    async evaluateBatch(batch) {
      this.calls += 1;
      return { scores: new Map(batch.items.map((item) => [item.id, scoreOf(item.path)])), invalid: [],
        usage: { inputTokens: 10, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
        transmittedBytes: 0, requestId: null };
    },
  };
}

/** One request attempt evaluates 64 of the 70 fragments. */
function cappedWorkspace(cacheEnabled = true) {
  return createWorkspace({ files, configure: (config) => ({
    ...config, scan_caps: { ...config.scan_caps, request_attempts: 1 },
    cache: { ...config.cache, enabled: cacheEnabled },
  }) });
}

const request = { query: 'Where is invalidation?', allow_partial_scan: true };

function asResult(outcome: SearchResult | SearchError): SearchResult {
  assert.ok('excerpts' in outcome, JSON.stringify(outcome));
  return outcome;
}

function asError(outcome: SearchResult | SearchError): SearchError {
  assert.ok('error' in outcome, JSON.stringify(outcome));
  return outcome;
}

test('a continued search evaluates only what was left and never repeats delivered excerpts', async () => {
  const space = cappedWorkspace();
  const provider = countingProvider();
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider });
    const delivered: string[] = [];
    const rounds: SearchResult[] = [];
    let token: string | undefined;
    do {
      const result = asResult((await engine.search({ ...request, ...(token === undefined ? {} : { continuation: token }) })).outcome);
      assert.equal(result.continuation?.previously_delivered_omitted, Math.min(delivered.length, 70));
      for (const excerpt of result.excerpts) {
        assert.ok(!delivered.includes(excerpt.path), `${excerpt.path} was delivered twice`);
        delivered.push(excerpt.path);
      }
      rounds.push(result);
      token = result.continuation?.next ?? undefined;
    } while (token !== undefined && rounds.length < 40);
    assert.equal(rounds[0]?.status, 'partial');
    assert.equal(rounds[0]?.report.fragments.remote_evaluated, 64);
    assert.equal(rounds[1]?.report.fragments.remote_evaluated, 6);
    assert.equal(rounds.at(-1)?.status, 'complete');
    assert.equal(provider.calls, 2, 'later rounds reuse cached scores');
    assert.deepEqual([...delivered].sort(), Object.keys(files));
  } finally { space.cleanup(); }
});

test('a continuation is refused when the query or scope changes, before any provider call', async () => {
  const space = cappedWorkspace();
  const provider = countingProvider();
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider });
    const first = asResult((await engine.search(request)).outcome);
    const token = first.continuation?.next;
    assert.ok(typeof token === 'string');
    for (const changed of [{ query: 'Something else?' }, { query: request.query, scope: ['src/file-00.ts'] }]) {
      const error = asError((await engine.search({ ...changed, allow_partial_scan: true, continuation: token })).outcome);
      assert.equal(error.error.code, 'INVALID_REQUEST');
    }
    const malformed = asError((await engine.search({ ...request, continuation: 'jgc1.@@' })).outcome);
    assert.equal(malformed.error.code, 'INVALID_REQUEST');
    assert.equal(provider.calls, 1);
  } finally { space.cleanup(); }
});

test('a delivered file that changes becomes new evidence again', async () => {
  const space = cappedWorkspace();
  try {
    const provider = countingProvider((path) => path === 'src/file-00.ts' ? 0.95 : 0.9);
    const engine = createSearchEngine({ configuration: space.loaded, provider });
    const round1 = asResult((await engine.search(request)).outcome);
    assert.equal(round1.excerpts[0]?.path, 'src/file-00.ts');
    const token = round1.continuation?.next;
    assert.ok(typeof token === 'string');
    space.write('src/file-00.ts', 'export const invalidate0 = 42;\n');
    const round2 = asResult((await engine.search({ ...request, continuation: token })).outcome);
    assert.equal(round2.excerpts[0]?.path, 'src/file-00.ts', 'the edited file is delivered again');
    assert.equal(round2.continuation?.previously_delivered_omitted, round1.excerpts.length - 1);
  } finally { space.cleanup(); }
});

test('without a score cache no continuation is offered and a token is refused', async () => {
  const space = cappedWorkspace(false);
  const provider = countingProvider();
  try {
    const engine = createSearchEngine({ configuration: space.loaded, provider });
    const result = asResult((await engine.search(request)).outcome);
    assert.equal(result.status, 'partial');
    assert.equal(result.continuation, undefined);
    const error = asError((await engine.search({ ...request, continuation: 'jgc1.AAAAAAAAAAA' })).outcome);
    assert.equal(error.error.code, 'INVALID_REQUEST');
  } finally { space.cleanup(); }
});

test('the token stays bounded and the human view prints how to continue', async () => {
  const many = new Set(Array.from({ length: MAX_DELIVERED_FRAGMENTS + 1 }, (_, index) => index.toString(16).padStart(16, '0')));
  assert.equal(encodeContinuation(Buffer.alloc(8), many), null);
  const space = cappedWorkspace();
  try {
    const result = asResult((await createSearchEngine({ configuration: space.loaded, provider: countingProvider() })
      .search(request)).outcome);
    const view = renderHumanOutcome(result, referenceCounter, 4_000).text;
    assert.ok(view.includes(`continue: --continuation ${result.continuation!.next!}`));
  } finally { space.cleanup(); }
});
