import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheUser, cachedUser } from '../src/cache.ts';
import { handleWebhook } from '../src/handler.ts';

test('subscription changes invalidate cached user data', () => {
  cacheUser('u-1', '{"plan":"old"}');
  handleWebhook('{"kind":"subscription.changed","userId":"u-1","plan":"new"}');
  assert.equal(cachedUser('u-1'), undefined);
});
