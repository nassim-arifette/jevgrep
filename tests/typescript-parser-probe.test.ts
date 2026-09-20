import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROBE_SOURCE, probeTypeScriptParser } from '../scripts/probe-typescript-parser.ts';

/**
 * The parser-availability probe (JG-015).
 *
 * The chunker's boundaries come from a pinned syntax parser. That choice rests on a
 * fact about the installed packages, so the fact is checked here rather than asserted
 * in prose: the probe runs each candidate entry point in its own child process — one
 * of them has been seen to abort rather than throw — and reports what it found.
 *
 * This test is a drift alarm. If the pinned parser stops parsing, the chunker loses
 * its boundaries silently; if the main `typescript` entry point gains a syntax parser,
 * the dependency decision is worth revisiting. Either way the suite says so.
 */

test('the probe returns a verdict for every candidate entry point', () => {
  const verdicts = probeTypeScriptParser();
  assert.ok(verdicts.length >= 3, 'every documented candidate is probed');
  for (const verdict of verdicts) {
    assert.ok(['usable', 'absent', 'misbehaved', 'crashed'].includes(verdict.status),
      `unknown status for ${verdict.candidate}: ${verdict.status}`);
    assert.ok(verdict.detail.length > 0, `${verdict.candidate} must explain its verdict`);
  }
});

test('the pinned parser the chunker depends on is usable on this runtime', () => {
  const verdicts = probeTypeScriptParser();
  const pinned = verdicts.find((verdict) => verdict.candidate === 'pinned-parser-api');
  assert.ok(pinned !== undefined, 'the pinned parser must be probed');
  assert.equal(pinned.status, 'usable',
    `the syntax chunker depends on this parser: ${pinned.detail}`);
});

test('the probe sample exercises the constructs the decision was made on', () => {
  // A probe that only parses `const x = 1;` would prove nothing about the cases the
  // chunker actually has to survive.
  assert.match(PROBE_SOURCE, /\/\*\* doc \*\//, 'a documentation comment');
  assert.match(PROBE_SOURCE, /\/ab\[\/\]c\/g/, 'a regular expression containing a slash');
  assert.match(PROBE_SOURCE, /`value:\$\{/, 'a template literal with an expression hole');
  assert.match(PROBE_SOURCE, /class Registry/, 'a class with a member');
});

test('a candidate that is absent or misbehaving is recorded, not hidden', () => {
  const verdicts = probeTypeScriptParser();
  const others = verdicts.filter((verdict) => verdict.candidate !== 'pinned-parser-api');
  assert.ok(others.length >= 2);
  for (const verdict of others) {
    // No assertion on which way they fall: the point is that the answer is recorded.
    // A candidate flipping to `usable` is a reason to reconsider the separate
    // runtime parser dependency, not a reason to fail.
    assert.ok(verdict.detail.length > 0, `${verdict.candidate} produced an empty verdict`);
  }
});
