import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matrixScenarios, runMatrixSample, summarizeMatrix } from '../scripts/bench/matrix.ts';

/** Protect scenario meaning, failure-inclusive summaries and percentile sample requirements. */
test('the offline performance matrix exercises cache transitions, continuations, deadlines and MCP responsiveness', { timeout: 60_000 }, async () => {
  const sample = await runMatrixSample(4);
  assert.match(sample.workloadHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(sample.rows.map((row) => row.scenario), [...matrixScenarios]);
  const row = (scenario: typeof matrixScenarios[number]) => sample.rows.find((entry) => entry.scenario === scenario)!;
  assert.ok(row('cold').providerAttempts > 0);
  assert.equal(row('identical_query').providerAttempts, 0);
  assert.ok(row('identical_query').cacheReused > 0);
  assert.equal(row('new_query').cacheReused, 0);
  assert.ok(row('edited_file').remoteEvaluated > 0 && row('edited_file').cacheReused > 0);
  assert.equal(row('shifted_function').remoteEvaluated, 1);
  assert.equal(row('shifted_function').cacheReused, 2);
  assert.equal(row('continuation').remoteEvaluated, 6);
  assert.equal(row('continuation').cacheReused, 64);
  assert.equal(row('multiquestion').questions, 2);
  assert.equal(row('multiquestion').complete, 2);
  for (const phase of ['preparation', 'planning', 'evaluation', 'selection'] as const) {
    assert.ok(row(`deadline_${phase}`).stopReasons.includes('DEADLINE'));
    assert.equal(row(`deadline_${phase}`).complete, 0);
  }
  assert.ok(row('cancellation').cancellationReturnMs !== null);
  assert.equal(row('cancellation').complete, 0);
  assert.ok(row('mcp_ping').mcpPingLatencyMs !== null);
  assert.equal(row('mcp_ping').providerAttempts, 0);
  const summary = summarizeMatrix([sample]);
  assert.ok(summary.every((entry) => entry.latencyMs.p95 === null));
  assert.equal(summary.find((entry) => entry.scenario === 'cancellation')?.completionRate, 0);
  assert.equal(summarizeMatrix(Array.from({ length: 20 }, () => sample))[0]?.latencyMs.p95, sample.rows[0]?.elapsedMs);
});
