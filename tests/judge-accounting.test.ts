import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { judgeCaseTiming, judgeWithRetries, summarizeJudgeUsage, type JudgeReply, type JudgeRequest } from '../scripts/bench/judge-accounting.ts';

const knownUsage = { input_tokens: 100, output_tokens: 10,
  input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 2 } };
const request: JudgeRequest = { ids: ['a'], inputTokens: 100, cachedTokens: 20, outputTokens: 10, reasoningTokens: 2,
  bytes: 100, ms: 10, error: null };
const price = { input: 2, cached: 1, output: 4 };

test('every retryable response and transport failure is recorded with actual backoff', async () => {
  let clock = 0;
  let calls = 0;
  const replies: (JudgeReply | Error)[] = [
    { status: 503, raw: { error: 'busy', usage: { input_tokens: 10, output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    new Error('connection closed'), { status: 429, raw: { error: 'rate limit' } },
    { status: 200, raw: { usage: knownUsage } },
  ];
  const result = await judgeWithRetries({
    ids: ['a'], bytes: 123,
    send: async () => { const reply = replies[calls++]!; clock += calls * 10; if (reply instanceof Error) throw reply; return reply; },
    parse: () => new Map([['a', 0.9]]), now: () => clock,
    sleep: async (ms) => { clock += ms + 1; },
  });
  assert.equal(result.scores.get('a'), 0.9);
  assert.equal(result.requests.length, 4);
  assert.deepEqual(result.requests.map((entry) => entry.status), [503, null, 429, 200]);
  assert.deepEqual(result.requests.map((entry) => entry.attempt), [1, 2, 3, 4]);
  assert.deepEqual(result.requests.map((entry) => entry.ms), [10, 20, 30, 40]);
  assert.deepEqual(result.requests.map((entry) => entry.requestedBackoffMs), [3_000, 6_000, 9_000, 0]);
  assert.deepEqual(result.requests.map((entry) => entry.backoffMs), [3_001, 6_001, 9_001, 0]);
  assert.match(result.requests[0]!.error!, /503/);
  assert.equal(result.requests[1]!.error, 'connection closed');
  assert.match(result.requests[2]!.error!, /429/);
  assert.equal(result.requests[3]!.error, null);
  const usage = summarizeJudgeUsage(result.requests, price);
  assert.equal(usage.inputTokens, 110);
  assert.equal(usage.outputTokens, 11);
  assert.equal(usage.unknownInputUsageAttempts, 2);
  assert.equal(usage.unknownUsageAttempts, 2);
  assert.equal(usage.unknownCostAttempts, 2);
  assert.ok(Math.abs(usage.knownUsd! - 244 / 1e6) < 1e-12);
  assert.equal(usage.usd, null);
  assert.equal(usage.backoffMs, 18_003);
  assert.equal(usage.attemptedBytes, 492, 'a transport failure retains attempted request bytes');
  assert.equal(judgeCaseTiming({ requests: result.requests, wallMs: clock }).ms, 18_103);
});

test('retries are bounded and nonretryable HTTP failures stop immediately', async () => {
  for (const status of [500, 401]) {
    let clock = 0;
    const result = await judgeWithRetries({
      ids: ['a'], bytes: 123,
      send: async () => { clock += 10; return { status, raw: {} }; },
      parse: () => assert.fail('HTTP failure must not be parsed'), now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    assert.equal(result.requests.length, status === 500 ? 5 : 1);
    assert.equal(result.requests.at(-1)!.requestedBackoffMs, 0);
    assert.ok(result.requests.every((entry) => entry.error !== null));
    assert.equal(summarizeJudgeUsage(result.requests, price).unknownCostAttempts, result.requests.length);
  }
});

test('unparsable and missing judgments retain usage without inventing scores or retrying', async () => {
  for (const malformed of [true, false]) {
    const result = await judgeWithRetries({ ids: ['a'], bytes: 10,
      send: async () => ({ status: 200, raw: { usage: knownUsage } }),
      parse: () => { if (malformed) throw new Error('invalid JSON'); return new Map(); },
      now: () => 0, sleep: async () => assert.fail('successful transport must not retry'),
    });
    assert.equal(result.requests.length, 1);
    assert.equal(result.scores.size, 0);
    assert.match(result.requests[0]!.error!, malformed ? /unparsable/ : /missing answers/);
    assert.equal(summarizeJudgeUsage(result.requests, price).usd, 220 / 1e6);
  }
});

test('invalid token counts and inconsistent subcounts remain unknown', async () => {
  const result = await judgeWithRetries({ ids: ['a'], bytes: 10,
    send: async () => ({ status: 200, raw: { usage: {
      input_tokens: -1, output_tokens: 0.5, input_tokens_details: { cached_tokens: NaN }, output_tokens_details: { reasoning_tokens: '2' },
    } } }),
    parse: () => new Map([['a', 0.9]]), now: () => 0, sleep: async () => {},
  });
  assert.equal(result.requests[0]!.inputTokens, null);
  assert.equal(result.requests[0]!.cachedTokens, null);
  assert.equal(result.requests[0]!.outputTokens, null);
  assert.equal(result.requests[0]!.reasoningTokens, null);
  assert.equal(summarizeJudgeUsage(result.requests, price).usd, null);
  const excessiveSubcounts = await judgeWithRetries({ ids: ['a'], bytes: 10,
    send: async () => ({ status: 200, raw: { usage: { input_tokens: 10, output_tokens: 2,
      input_tokens_details: { cached_tokens: 11 }, output_tokens_details: { reasoning_tokens: 3 } } } }),
    parse: () => new Map([['a', 0.9]]), now: () => 0, sleep: async () => {},
  });
  assert.equal(excessiveSubcounts.requests[0]!.cachedTokens, null);
  assert.equal(excessiveSubcounts.requests[0]!.reasoningTokens, null);
});

test('an unreadable response body retains its HTTP status and does not fabricate scores', async () => {
  const result = await judgeWithRetries({ ids: ['a'], bytes: 10,
    send: async () => ({ status: 200, raw: {}, error: 'unparsable response body' }),
    parse: () => assert.fail('an invalid body cannot be parsed for scores'), now: () => 0, sleep: async () => {},
  });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]!.status, 200);
  assert.equal(result.requests[0]!.error, 'unparsable response body');
});

test('known subtotals survive unknown billable dimensions, and zero-priced dimensions need no estimate', () => {
  const unknownInput = { ...request, inputTokens: null };
  const unknownOutput = { ...request, outputTokens: null };
  const missingCached = { ...request, cachedTokens: null };
  assert.equal(summarizeJudgeUsage([unknownInput], price).knownUsd, 40 / 1e6);
  assert.equal(summarizeJudgeUsage([unknownOutput], price).knownUsd, 180 / 1e6);
  assert.equal(summarizeJudgeUsage([missingCached], price).usd, null);
  assert.equal(summarizeJudgeUsage([request]).usd, null, 'missing prices do not imply free usage');
  assert.equal(summarizeJudgeUsage([unknownOutput], { ...price, output: 0 }).usd, 180 / 1e6);
  assert.equal(summarizeJudgeUsage([missingCached], { ...price, cached: 2 }).usd, 240 / 1e6);
});

test('legacy reports remain readable and timing is explicitly a lower bound', () => {
  const file = JSON.parse(readFileSync(new URL('../benchmarks/baselines/judge-judgments-2026-11-04-jev-1.14.0.json', import.meta.url), 'utf8')) as {
    cases: { requests: JudgeRequest[] }[];
  };
  const requests = file.cases.flatMap((entry) => entry.requests);
  const timing = judgeCaseTiming(file.cases[0]!);
  assert.equal(timing.source, 'recorded-attempts-lower-bound');
  assert.equal(timing.ms, file.cases[0]!.requests.reduce((sum, entry) => sum + entry.ms, 0));
  const usage = summarizeJudgeUsage(requests, { input: 0.042, cached: 0.042, output: 0 });
  assert.equal(usage.unknownOutputUsageAttempts, requests.length);
  assert.equal(usage.usd, usage.knownUsd, 'missing zero-priced output does not invalidate recorded Jev input cost');
  assert.equal(judgeCaseTiming({ requests: [request], wallMs: 1_234 }).source, 'wall');
  assert.equal(judgeCaseTiming({ requests: [request], wallMs: 1_234 }).ms, 1_234);
});

test('judge requires an explicit chunk configuration before any provider work', () => {
  const child = spawnSync(process.execPath, ['scripts/bench-openai-judges.ts', 'judge', '--arm', 'chat', '--model', 'offline'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /judge needs --chunk-config/);
  assert.ok(!child.stderr.includes('/home/ubuntu/'));
});
