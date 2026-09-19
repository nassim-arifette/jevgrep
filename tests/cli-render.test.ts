import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderHumanOutcome } from '../src/cli-render.ts';
import { referenceCounter } from '../src/response/token-counter.ts';
import { resultFixture } from './fixtures/contracts.ts';

/**
 * JG-023 human renderer (specification 2.2, 4.2 and 4.5).
 *
 * Rules under test:
 * - excerpts are the original source slices, never edited, summarized or re-indented;
 * - the header states what the search actually covered, and a partial or failed search says
 *   so instead of implying absence (requirement R8);
 * - the human view measures its own complete representation: that count is separate from the
 *   response budget, which belongs to the canonical JSON payload (specification 4.5).
 */
test('a complete result renders a header, the excerpt and its own size', () => {
  const outcome = resultFixture('complete');
  const rendered = renderHumanOutcome(outcome, referenceCounter);

  assert.match(rendered.text, /^jevgrep: complete/);
  assert.match(rendered.text, /1 excerpt/);
  assert.match(rendered.text, /src\/cache\.ts:2-2/);
  // The original slice appears verbatim, CRLF included: the renderer adds no indentation.
  assert.ok(rendered.text.includes('cache.clear();\r\n'), 'the excerpt text must survive verbatim');
  assert.equal(rendered.excerptCount, 1);
  assert.equal(rendered.tokenCount, referenceCounter.count(rendered.text));
  assert.equal(rendered.counter, referenceCounter.id);
  assert.match(rendered.text, /human view/);
});

test('a partial result names the stop reason and never claims absence', () => {
  const outcome = resultFixture('partial');
  const rendered = renderHumanOutcome(outcome, referenceCounter);

  assert.match(rendered.text, /^jevgrep: partial/);
  assert.match(rendered.text, /PROVIDER_UNAVAILABLE/);
  assert.match(rendered.text, /coverage/i);
  assert.doesNotMatch(rendered.text, /no result|nothing found|absent/i);
});

test('a rejected request explains the refusal and offers no excerpt', () => {
  const outcome = resultFixture('rejected');
  const rendered = renderHumanOutcome(outcome, referenceCounter);

  assert.match(rendered.text, /^jevgrep: rejected/);
  assert.equal(rendered.excerptCount, 0);
  assert.doesNotMatch(rendered.text, /^ {2}/m, 'a refusal carries no source block');
});

test('a failed search reports the error code without inventing evidence', () => {
  const outcome = resultFixture('error');
  const rendered = renderHumanOutcome(outcome, referenceCounter);

  assert.match(rendered.text, /^jevgrep: error/);
  assert.equal(rendered.excerptCount, 0);
  assert.ok(rendered.text.length > 0);
});

test('the rendered text is deterministic and its size is not under-reported', () => {
  const outcome = resultFixture('complete');
  const first = renderHumanOutcome(outcome, referenceCounter);
  const second = renderHumanOutcome(outcome, referenceCounter);

  assert.equal(first.text, second.text);
  assert.equal(first.tokenCount, second.tokenCount);
  assert.ok(first.tokenCount > 0);
  assert.equal(first.byteCount, Buffer.byteLength(first.text, 'utf8'));
});

test('an unknown fragment total stays unknown in the human report', () => {
  const outcome = resultFixture('partial');
  outcome.report.fragments.total = null;
  assert.match(renderHumanOutcome(outcome, referenceCounter).text, /unknown total fragments/);
});

test('the human budget removes whole excerpts and measures every byte of the final rendering', () => {
  const outcome = resultFixture('complete');
  const excerpt = outcome.excerpts[0];
  assert.ok(excerpt);
  excerpt.code = 'unchanged source line\n'.repeat(1_000);
  const rendered = renderHumanOutcome(outcome, referenceCounter, 200);
  assert.equal(rendered.excerptCount, 0);
  assert.ok(rendered.tokenCount <= 200);
  assert.equal(rendered.tokenCount, referenceCounter.count(rendered.text));
  assert.match(rendered.text, /omitted to fit/);
  assert.ok(!rendered.text.includes('unchanged source line'));
});
