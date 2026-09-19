import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/offline-preload.ts';
import { AbortError, ManualClock } from '../src/testing/manual-clock.ts';
import {
  ScriptedHttpResponseError,
  ScriptedProvider,
  type ScriptedStep,
} from '../src/testing/scripted-provider.ts';

async function settle(): Promise<void> {
  await Promise.resolve();
}

test('the manual clock resolves equal deadlines in registration order', async () => {
  const clock = new ManualClock(100);
  const order: string[] = [];
  const first = clock.sleep(10).then(() => order.push('first'));
  const second = clock.sleep(10).then(() => order.push('second'));

  clock.advanceBy(9);
  await settle();
  assert.deepEqual(order, []);
  clock.advanceBy(1);
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(clock.nowMs, 110);
});

test('a scenario controls completion order and preserves exact request bytes', async () => {
  const clock = new ManualClock();
  const steps: readonly ScriptedStep[] = [
    { kind: 'success', id: 'slow', delayMs: 20, response: { answers: [{ score: 0.8 }] }, declaredUsage: 12 },
    { kind: 'success', id: 'fast', delayMs: 5, response: { answers: [{ score: null }] }, declaredUsage: null },
  ];
  const provider = new ScriptedProvider(clock, steps);
  const firstBytes = Uint8Array.from([0, 1, 2, 255]);
  const first = provider.evaluate(firstBytes);
  const second = provider.evaluate('unicode: é');

  firstBytes.fill(9);
  clock.advanceBy(5);
  await settle();
  assert.deepEqual(provider.completionOrder, ['fast']);
  clock.advanceBy(15);

  const [slow, fast] = await Promise.all([first, second]);
  assert.deepEqual(slow, { response: { answers: [{ score: 0.8 }] }, declaredUsage: 12 });
  assert.deepEqual(fast, { response: { answers: [{ score: null }] }, declaredUsage: null });
  assert.deepEqual(provider.completionOrder, ['fast', 'slow']);
  assert.deepEqual([...provider.attempts[0]!.requestBytes], [0, 1, 2, 255]);
  assert.equal(new TextDecoder().decode(provider.attempts[1]!.requestBytes), 'unicode: é');
  assert.equal(provider.remainingStepCount, 0);
});

test('HTTP failures and malformed responses are not normalized by the fake', async () => {
  const clock = new ManualClock();
  const provider = new ScriptedProvider(clock, [
    { kind: 'success', id: 'malformed', delayMs: 0, response: { score: 'not-a-number' }, declaredUsage: null },
    { kind: 'http-error', id: 'rate-limit', delayMs: 0, status: 429, body: 'synthetic retry later' },
  ]);

  const malformedPromise = provider.evaluate('{}');
  clock.runAll();
  const malformed = await malformedPromise;
  assert.deepEqual(malformed.response, { score: 'not-a-number' });
  assert.equal(malformed.declaredUsage, null);

  const errorPromise = provider.evaluate('{}');
  clock.runAll();
  await assert.rejects(errorPromise, (error: unknown) => {
    assert.ok(error instanceof ScriptedHttpResponseError);
    assert.equal(error.status, 429);
    assert.equal(error.body, 'synthetic retry later');
    return true;
  });
});

test('cancellation removes the pending timer and prevents a completion', async () => {
  const clock = new ManualClock();
  const provider = new ScriptedProvider(clock, [
    { kind: 'success', id: 'delayed', delayMs: 100, response: {}, declaredUsage: 1 },
  ]);
  const controller = new AbortController();
  const result = provider.evaluate('request', controller.signal);
  assert.equal(clock.pendingTimerCount, 1);

  controller.abort();
  await assert.rejects(result, AbortError);
  assert.equal(clock.pendingTimerCount, 0);
  assert.deepEqual(provider.completionOrder, []);
  assert.equal(provider.attempts.length, 1);
});

test('the same script yields the same functional trace on every run', async () => {
  async function run(): Promise<unknown> {
    const clock = new ManualClock();
    const provider = new ScriptedProvider(clock, [
      { kind: 'success', id: 'one', delayMs: 3, response: { score: 0.25 }, declaredUsage: 7 },
      { kind: 'failure', id: 'two', delayMs: 1, message: 'synthetic transport failure' },
    ]);
    const one = provider.evaluate('one');
    const two = provider.evaluate('two').catch((error: unknown) => String(error));
    clock.runAll();
    return {
      results: await Promise.all([one, two]),
      attempts: provider.attempts.map((attempt) => ({
        ...attempt,
        requestBytes: [...attempt.requestBytes],
      })),
      completionOrder: provider.completionOrder,
    };
  }

  assert.deepEqual(await run(), await run());
});

test('a Buffer request and returned observations cannot mutate captured dispatch bytes', async () => {
  const clock = new ManualClock();
  const provider = new ScriptedProvider(clock, [
    { kind: 'success', id: 'buffer', delayMs: 0, response: {}, declaredUsage: null },
  ]);
  const body = Buffer.from('original');
  const result = provider.evaluate(body);
  body.fill(120);
  provider.attempts[0]!.requestBytes.fill(121);
  clock.runAll();
  await result;
  assert.equal(Buffer.from(provider.attempts[0]!.requestBytes).toString(), 'original');
});

test('delayed outcomes use the captured script, including malformed scores and unknown usage', async () => {
  const clock = new ManualClock();
  const response = { answers: [{ id: 'b', score: NaN }, { id: 'a', score: 0.8 }], missing: undefined };
  const step = { kind: 'success' as const, id: 'snapshot', delayMs: 5, response, declaredUsage: null };
  const provider = new ScriptedProvider(clock, [step]);
  step.id = 'changed';
  response.answers[1]!.score = 0;
  const pending = provider.evaluate('{}');
  clock.advanceBy(5);
  const result = await pending;
  assert.deepEqual(result.response, { answers: [{ id: 'b', score: NaN }, { id: 'a', score: 0.8 }], missing: undefined });
  assert.equal(result.declaredUsage, null);
  assert.equal(provider.completionOrder[0], 'snapshot');
});

test('cancellation before dispatch consumes neither a step nor an attempt', async () => {
  const clock = new ManualClock();
  const provider = new ScriptedProvider(clock, [
    { kind: 'success', id: 'unused', delayMs: 0, response: {}, declaredUsage: 0 },
  ]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.evaluate('{}', controller.signal), AbortError);
  assert.equal(provider.remainingStepCount, 1);
  assert.deepEqual(provider.attempts, []);
  assert.equal(clock.pendingTimerCount, 0);
});

test('scenario tests have an armed network guard', async () => {
  await assert.rejects(async () => fetch('https://provider.invalid/'), /offline guard blocked a fetch call/);
});

test('overflowing timer deadlines are rejected before a pending timer is created', () => {
  const clock = new ManualClock(Number.MAX_VALUE);
  assert.throws(() => clock.sleep(Number.MAX_VALUE), RangeError);
  assert.equal(clock.pendingTimerCount, 0);
});
