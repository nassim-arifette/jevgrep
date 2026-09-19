# Webhook outbox fixture

Synthetic TypeScript and SQL source for persistent webhook retry state.
A caller inserts pending rows with a due timestamp and runs one delivery worker.
A null next_at marks exhausted delivery; SQL comparisons exclude it from due rows.

Delivery can happen more than once if a process dies before recording success.
Recipients must enforce the idempotency key. Concurrent worker claiming and
authentication/signing are deliberately outside this small example.
