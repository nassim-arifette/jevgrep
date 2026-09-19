import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheUser, cachedUser } from '../src/cache.ts';
import { handleWebhook } from '../src/handler.ts';
import { drainRefreshQueue } from '../src/refresh-queue.ts';

test('subscription changes invalidate cached user data', () => {
  cacheUser('u-1', '{"plan":"old"}', 1000, 300);
  handleWebhook('{"kind":"subscription.changed","userId":"u-1","plan":"new"}');
  assert.equal(cachedUser('u-1', 1001), undefined);
});

test('duplicate profile events produce one refresh job', () => {
  handleWebhook('{"kind":"profile.changed","userId":"u-2"}');
  handleWebhook('{"kind":"profile.changed","userId":"u-2"}');
  assert.deepEqual(drainRefreshQueue(), ['u-2']);
});
