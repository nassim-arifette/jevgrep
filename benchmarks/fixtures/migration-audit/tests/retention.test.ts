import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batches, expired } from '../src/retention.ts';

test('legal holds survive retention', () => {
  const old = new Date('2020-01-01T00:00:00Z');
  const events = [
    { id: 'free', createdAt: old, legalHold: false },
    { id: 'held', createdAt: old, legalHold: true },
  ];
  assert.deepEqual(expired(events, new Date('2021-01-01T00:00:00Z'), 90), ['free']);
});

test('deletions are split into configured batches', () => {
  assert.deepEqual(batches(['a', 'b', 'c'], 2), [['a', 'b'], ['c']]);
});
