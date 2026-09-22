import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import { createSearchError, type SearchResult } from '../src/contracts.ts';
import { ProviderError, type ProviderClient } from '../src/evaluation/jev.ts';
import { questions, validateDataset, type RetrievalQuestion } from '../scripts/bench/dataset.ts';
import { distribution, runLocalSample } from '../scripts/bench/local.ts';
import { limitProvider } from '../scripts/bench/limited-provider.ts';
import { retrievalMetrics, summarizeRetrieval } from '../scripts/bench/retrieval.ts';
import { createWorkspace } from './helpers/search-workspace.ts';

test('retrieval pilot pins original fixtures and checks every annotation', () => {
  assert.equal(validateDataset().size, 3);
  assert.equal(questions.length, 30);
  assert.equal(questions.filter((question) => question.kind === 'negative').length, 6);
});

test('local benchmark exercises cold, repeated, new-query and edited-file cache states', async () => {
  const result = await runLocalSample(4);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[0]!.report.fragments.cache_reused, 0);
  assert.equal(result.rows[1]!.report.usage.provider_request_attempts, 0);
  assert.equal(result.rows[2]!.report.fragments.cache_reused, 0);
  assert.equal(result.rows[3]!.report.fragments.remote_evaluated, 1);
  assert.equal(result.rows[3]!.report.fragments.cache_reused, 3);
  assert.deepEqual(distribution([4, 1, 8, 2]), { min: 1, median: 3, max: 8 });
});

const successful: ProviderClient = {
  model: 'jev-1.13.0',
  async evaluateBatch(batch) {
    return {
      scores: new Map(batch.items.map((item) => [item.id, 0.9])), invalid: [],
      usage: { inputTokens: 10, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
      transmittedBytes: 100, requestId: null,
    };
  },
};

test('metrics require complete evidence, discount duplicates and do not count failed negatives', async () => {
  const space = createWorkspace({ files: { 'src/example.ts': 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n' } });
  try {
    const { outcome } = await createSearchEngine({ configuration: space.loaded, provider: successful }).search({ query: 'constants', max_context_tokens: 4_000 });
    assert.ok('report' in outcome);
    const excerpt = outcome.excerpts[0]!;
    const question: RetrievalQuestion = { id: 'metric', repository: 'access-gateway', kind: 'cross-file', query: 'example', evidence: [
      { path: excerpt.path, startLine: 1, endLine: 2 }, { path: 'other.ts', startLine: 1, endLine: 1 },
    ] };
    const result: SearchResult = { ...outcome, excerpts: [
      { ...excerpt, path: 'unrelated.ts' }, { ...excerpt, end_line: 1 },
      { ...excerpt, start_line: 2, end_line: 2 }, { ...excerpt }, { ...excerpt },
    ] };
    const metrics = retrievalMetrics(question, result)!;
    assert.equal(metrics.recallAt1, 0);
    assert.equal(metrics.recallAt5, 0.5);
    assert.equal(metrics.evidenceCoverage, 0.5);
    assert.equal(metrics.reciprocalRank, 0.25);
    const negative: RetrievalQuestion = { ...question, kind: 'negative', evidence: [] };
    assert.equal(retrievalMetrics(negative, { ...outcome, excerpts: [] })?.negativeCorrect, true);
    assert.equal(retrievalMetrics(negative, outcome)?.negativeCorrect, false);
    assert.equal(retrievalMetrics(negative, { ...outcome, status: 'partial', excerpts: [] }), null);
    assert.equal(retrievalMetrics(negative, createSearchError('PROVIDER_AUTH', 'failed')), null);
    const summary = summarizeRetrieval([metrics, null, retrievalMetrics(negative, { ...outcome, excerpts: [] })]);
    assert.equal(summary.incomplete, 1);
    assert.equal(summary.positiveQuestions, 1);
    assert.equal(summary.negativeQuestions, 1);
    assert.equal(summary.meanRecallAt5, 0.5);
  } finally { space.cleanup(); }
});

test('live benchmark caps reserve concurrent attempts and retain failed or unknown usage', async () => {
  let dispatched = 0;
  const failing: ProviderClient = { ...successful, async evaluateBatch() {
    dispatched += 1;
    throw new ProviderError({ code: 'PROVIDER_UNAVAILABLE', message: 'timeout', retryable: true, ambiguous: true });
  } };
  const batch = { query: 'test', items: [] };
  const limited = limitProvider(failing, () => 'test', { requests: 1, estimatedInputTokens: 100 });
  await Promise.allSettled([limited.provider.evaluateBatch(batch), limited.provider.evaluateBatch(batch)]);
  assert.equal(dispatched, 1);
  assert.equal(limited.usage.attempts, 1);
  assert.equal(limited.usage.unknownUsageAttempts, 1);
  assert.ok(limited.usage.reservedInputTokens > 0);
  assert.equal(limited.usage.blocked, true);
  const tokens = limitProvider(successful, () => 'one two three', { requests: 10, estimatedInputTokens: 1 });
  await assert.rejects(tokens.provider.evaluateBatch(batch), /dispatch cap/);
  assert.equal(tokens.usage.attempts, 0);
});
