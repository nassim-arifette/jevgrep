import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { SearchContext } from '../src/lifecycle.ts';
import { ManualClock } from '../src/testing/manual-clock.ts';
import { ProviderError, type BatchEvaluation, type EvaluationBatch, type ProviderClient } from '../src/evaluation/jev.ts';
import { runEvaluations } from '../src/evaluation/scheduler.ts';

const batch: EvaluationBatch = { query: 'q', items: [{ id: 'a', path: 'a.ts', startLine: 1, endLine: 1, text: 'a();' }] };
const answer: BatchEvaluation = {
  scores: new Map([['a', 0.9]]), invalid: [], usage: { inputTokens: 10, outputTokens: 0 },
  requestedModel: 'jev-1.13.0', returnedModel: 'jev-1.13.0', transmittedBytes: 1, requestId: null,
};
function refusal(options: Partial<ConstructorParameters<typeof ProviderError>[0]> = {}): ProviderError {
  return new ProviderError({ code: 'PROVIDER_RATE_LIMIT', message: 'synthetic refusal', retryable: true, ambiguous: false, ...options });
}

test('each retry reserves a fresh attempt and honors Retry-After before resending', async () => {
  const clock = new ManualClock();
  const context = new SearchContext({ clock });
  const times: number[] = [];
  const failures: boolean[] = [];
  let reservations = 0;
  let scores = 0;
  const provider: ProviderClient = { model: 'jev-1.13.0', async evaluateBatch() {
    times.push(clock.nowMs);
    if (times.length === 1) throw refusal({ retryAfterMs: 2_000 });
    return answer;
  } };
  const work = runEvaluations(provider, [batch], context, {
    concurrency: 1, random: () => 0,
    onDispatch: () => { reservations += 1; return true; },
    onScores: () => { scores += 1; }, onFailure: (_b, _f, retry) => { failures.push(retry); },
  });
  await setImmediate();
  clock.advanceBy(1_999); await setImmediate();
  assert.deepEqual(times, [0]);
  clock.advanceBy(1); await work;
  assert.deepEqual(times, [0, 2_000]);
  assert.equal(reservations, 2); assert.equal(scores, 1); assert.deepEqual(failures, [true]);
  await context.dispose(); assert.equal(clock.pendingTimerCount, 0);
});

test('retry count is finite and ambiguous failures are never automatically repeated', async () => {
  for (const ambiguous of [false, true]) {
    const clock = new ManualClock();
    const context = new SearchContext({ clock });
    let calls = 0;
    const failures: boolean[] = [];
    const work = runEvaluations({ model: 'test', async evaluateBatch() { calls++; throw refusal({ ambiguous }); } }, [batch], context, {
      concurrency: 4, random: () => 1, onScores: () => assert.fail(), onFailure: (_b, _f, retry) => { failures.push(retry); },
    });
    await setImmediate();
    clock.advanceBy(250); await setImmediate();
    clock.advanceBy(500); await work;
    assert.equal(calls, ambiguous ? 1 : 3);
    assert.equal(failures.at(-1), false);
    await context.dispose(); assert.equal(clock.pendingTimerCount, 0);
  }
});

test('remaining reservation capacity can refuse a retry without another provider call', async () => {
  const clock = new ManualClock(); const context = new SearchContext({ clock });
  let calls = 0; let admitted = false;
  const work = runEvaluations({ model: 'test', async evaluateBatch() { calls++; throw refusal(); } }, [batch], context, {
    concurrency: 1, onScores: () => assert.fail(), onFailure: () => undefined,
    onDispatch: () => { if (admitted) return false; admitted = true; return true; },
  });
  await setImmediate(); clock.advanceBy(250); await work;
  assert.equal(calls, 1); await context.dispose();
});

test('deadline stops backoff and cancellation detaches a transport that ignores abort', async () => {
  const clock = new ManualClock(); const context = new SearchContext({ clock, deadlineMs: 100 });
  let calls = 0;
  const backoff = runEvaluations({ model: 'test', async evaluateBatch() { calls++; throw refusal({ retryAfterMs: 5_000 }); } }, [batch], context, {
    concurrency: 1, onScores: () => assert.fail(), onFailure: () => undefined,
  });
  await setImmediate(); clock.advanceBy(100); await backoff;
  assert.equal(calls, 1); assert.equal(context.stop, 'deadline'); await context.dispose();

  const cancelled = new SearchContext({ clock });
  let complete!: (answer: BatchEvaluation) => void;
  let seenAbort = false; let failures = 0;
  const pending = runEvaluations({ model: 'test', evaluateBatch(_batch, signal) {
    signal!.addEventListener('abort', () => { seenAbort = true; });
    return new Promise((resolve) => { complete = resolve; });
  } }, [batch, batch], cancelled, {
    concurrency: 1, onScores: () => assert.fail('late score must be ignored'),
    onFailure: (_b, failure) => { failures++; assert.ok(failure.cancelled && failure.ambiguous); },
  });
  await setImmediate(); cancelled.cancel(); await pending;
  complete(answer); await setImmediate();
  assert.ok(seenAbort); assert.equal(failures, 1); await cancelled.dispose();
  assert.equal(clock.pendingTimerCount, 0);
});

test('terminal authorization errors stop queued work but preserve already completed scores', async () => {
  const context = new SearchContext(); let calls = 0; let scores = 0;
  await runEvaluations({ model: 'test', async evaluateBatch() {
    if (++calls === 2) throw refusal({ code: 'PROVIDER_AUTH', status: 403, retryable: false });
    return answer;
  } }, [batch, batch, batch], context, {
    concurrency: 1, onScores: () => { scores++; }, onFailure: () => undefined,
  });
  assert.equal(calls, 2); assert.equal(scores, 1); await context.dispose();
});

test('concurrency is bounded while independent completions release permits', async () => {
  const context = new SearchContext(); let inFlight = 0; let maximum = 0; let scores = 0;
  await runEvaluations({ model: 'test', async evaluateBatch() {
    maximum = Math.max(maximum, ++inFlight); await setImmediate(); inFlight--; return answer;
  } }, Array.from({ length: 7 }, () => batch), context, {
    concurrency: 2, onScores: () => { scores++; }, onFailure: () => assert.fail(),
  });
  assert.equal(maximum, 2); assert.equal(scores, 7); await context.dispose();
});

test('Retry-After pauses later batches even when retrying the refused batch is disabled', async () => {
  const clock = new ManualClock(); const context = new SearchContext({ clock });
  const times: number[] = [];
  const work = runEvaluations({ model: 'test', async evaluateBatch() {
    times.push(clock.nowMs); if (times.length === 1) throw refusal({ retryAfterMs: 5_000 }); return answer;
  } }, [batch, batch], context, {
    concurrency: 1, retry: { max_retries: 0, base_delay_ms: 1, max_delay_ms: 1, retry_ambiguous: false },
    onScores: () => undefined, onFailure: () => undefined,
  });
  await setImmediate(); clock.advanceBy(4_999); await setImmediate();
  assert.deepEqual(times, [0]); clock.advanceBy(1); await work;
  assert.deepEqual(times, [0, 5_000]); await context.dispose();
});

test('a real CLI process stays alive during backoff and exits after retry cleanup', () => {
  const schedulerUrl = new URL('../src/evaluation/scheduler.ts', import.meta.url).href;
  const lifecycleUrl = new URL('../src/lifecycle.ts', import.meta.url).href;
  const jevUrl = new URL('../src/evaluation/jev.ts', import.meta.url).href;
  const script = `import { runEvaluations } from ${JSON.stringify(schedulerUrl)};
    import { SearchContext } from ${JSON.stringify(lifecycleUrl)};
    import { ProviderError } from ${JSON.stringify(jevUrl)};
    const context = new SearchContext(); let calls = 0;
    await runEvaluations({model:'test', async evaluateBatch() {
      if (++calls === 1) throw new ProviderError({code:'PROVIDER_RATE_LIMIT', message:'refused', retryable:true, ambiguous:false});
      return {};
    }}, [{query:'q', items:[]}], context, {
      concurrency:1, retry:{max_retries:2,base_delay_ms:25,max_delay_ms:25,retry_ambiguous:false},
      onScores() {}, onFailure() {}
    }); await context.dispose(); console.log(calls);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '2');
});
