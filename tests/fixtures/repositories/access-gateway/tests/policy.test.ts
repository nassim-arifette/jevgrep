import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayEnter } from '../src/policy.ts';

test('requires the configured role', () => {
  assert.equal(mayEnter({ id: 'member-1', roles: ['member'] }, 'administrator'), false);
});
