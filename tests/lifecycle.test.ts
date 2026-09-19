import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DiagnosticsRecorder, SearchContext, SearchLogger, isAbortError, runPhase } from '../src/lifecycle.ts';
import { CONTRACT_LIMITS } from '../src/contracts.ts';
import { ManualClock } from '../src/testing/manual-clock.ts';

/**
 * Search lifecycle and local diagnostics (JG-009).
 *
 * Every stop is reachable without waiting for real time, an internal deadline and a
 * client cancellation stay distinguishable, and diagnostics never carry source text,
 * credentials, provider bodies or the question.
 */

test('an internal deadline stops new work without real time passing', () => {
  const clock = new ManualClock(1_000);
  const context = new SearchContext({ clock, deadlineMs: 5_000, searchId: 'deadline-case' });

  assert.equal(context.canStartWork(), true);
  assert.equal(context.remainingMs, 5_000);

  clock.advanceBy(5_000);
  assert.equal(context.canStartWork(), false);
  assert.equal(context.stop, 'deadline');
  assert.deepEqual(context.stopReasons(), ['DEADLINE']);
  assert.equal(context.signal.aborted, true);
});

test('a client cancellation is not a deadline', () => {
  const clock = new ManualClock();
  const controller = new AbortController();
  const context = new SearchContext({ clock, deadlineMs: 60_000, clientSignal: controller.signal });

  controller.abort();
  assert.equal(context.stop, 'client_cancelled');
  assert.deepEqual(context.stopReasons(), ['CANCELLED']);
  assert.equal(context.canStartWork(), false);
});

test('a search cancelled before it starts never reports a deadline', () => {
  const controller = new AbortController();
  controller.abort();
  const context = new SearchContext({ clock: new ManualClock(), clientSignal: controller.signal });
  assert.equal(context.stop, 'client_cancelled');
});

test('queue waiting consumes the same deadline as evaluation', async () => {
  const clock = new ManualClock();
  const context = new SearchContext({ clock, deadlineMs: 2_000 });

  const waiting = context.clock.sleep(1_500, context.signal);
  clock.advanceBy(1_500);
  await waiting;
  assert.equal(context.remainingMs, 500);
  assert.equal(context.canStartWork(), true);

  clock.advanceBy(500);
  assert.equal(context.canStartWork(), false, 'time spent waiting for a slot still expires the deadline');
});

test('registered resources are released on every exit path, in reverse order', async () => {
  const released: string[] = [];
  const context = new SearchContext({ clock: new ManualClock() });
  context.onDispose(() => {
    released.push('permit');
  });
  context.onDispose(() => {
    throw new Error('a failing cleanup must not mask the others');
  });
  context.onDispose(async () => {
    await Promise.resolve();
    released.push('handle');
  });

  await context.dispose();
  await context.dispose();
  assert.deepEqual(released, ['handle', 'permit']);
  assert.equal(context.signal.aborted, true);
});

test('a phase failure is logged with its stage and distinguishes cancellation', async () => {
  const lines: string[] = [];
  const context = new SearchContext({
    clock: new ManualClock(),
    logger: new SearchLogger('debug', (line) => lines.push(line)),
    searchId: 'phase-case',
  });

  await runPhase(context, 'inventory', () => Promise.resolve(1));
  await assert.rejects(runPhase(context, 'evaluation', () => Promise.reject(new Error('provider down'))));

  assert.ok(lines.some((line) => line.includes('phase.inventory')));
  const failure = lines.find((line) => line.includes('phase.evaluation.failed'));
  assert.ok(failure !== undefined);
  assert.ok(failure.includes('cancelled=false'));
  assert.ok(!lines.join('\n').includes('provider down'), 'a provider message never reaches the log line');
});

test('diagnostics stay bounded and say so', () => {
  const diagnostics = new DiagnosticsRecorder('bounded-case');
  for (let index = 0; index < CONTRACT_LIMITS.diagnostic_events + 25; index += 1) {
    diagnostics.record('CACHE_MISS', index, { count: 1 });
  }
  diagnostics.recordExcludedDirectory('dependency');
  diagnostics.recordExcludedDirectory('dependency');
  diagnostics.observeCapLowerBound('transmitted_bytes', 2_048);
  diagnostics.observeCapLowerBound('transmitted_bytes', 1_024);
  diagnostics.setResponseTokensMeasured(3_120);

  const record = diagnostics.toJSON();
  assert.equal(record.events.length, CONTRACT_LIMITS.diagnostic_events);
  assert.equal(record.truncated, true);
  assert.deepEqual(record.excluded_directories_by_reason, { dependency: 2 });
  assert.deepEqual(record.observed_cap_lower_bounds, { transmitted_bytes: 2_048 });
  assert.equal(record.response_tokens_measured, 3_120);
});

test('diagnostic events carry codes and counters, never source or question text', () => {
  const diagnostics = new DiagnosticsRecorder('redaction-case');
  diagnostics.record('PARSE_FALLBACK', 12, { count: 2, path: 'src/policy.ts' });
  const serialized = JSON.stringify(diagnostics.toJSON());
  assert.ok(serialized.includes('PARSE_FALLBACK'));
  assert.ok(serialized.includes('src/policy.ts'), 'a relative path is allowed in local diagnostics');
  assert.ok(!/secret|Bearer|function |const /i.test(serialized), 'no source or credential material is recorded');
});

test('abort errors from the manual clock are recognized as cancellations', async () => {
  const clock = new ManualClock();
  const controller = new AbortController();
  const sleeping = clock.sleep(1_000, controller.signal);
  controller.abort();
  await assert.rejects(sleeping, (error: unknown) => isAbortError(error));
});
