import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireRole } from '../src/middleware/authenticate';

function responseRecorder() {
  const recorded: { status?: number; body?: unknown } = {};
  return {
    recorded,
    response: {
      status(code: number) {
        recorded.status = code;
        return this;
      },
      json(body: unknown) {
        recorded.body = body;
        return this;
      },
    },
  };
}

test('a customer role cannot reach an agent-only handler', () => {
  const { recorded, response } = responseRecorder();
  const middleware = requireRole('agent');
  let nextCalled = false;

  middleware(
    { session: { userId: 'u-1', role: 'customer' } } as never,
    response as never,
    () => {
      nextCalled = true;
    },
  );

  assert.equal(nextCalled, false);
  assert.equal(recorded.status, 403);
});

test('an admin role passes the agent check because roles are ordered', () => {
  const { response } = responseRecorder();
  const middleware = requireRole('agent');
  let nextCalled = false;

  middleware(
    { session: { userId: 'u-2', role: 'admin' } } as never,
    response as never,
    () => {
      nextCalled = true;
    },
  );

  assert.equal(nextCalled, true);
});
