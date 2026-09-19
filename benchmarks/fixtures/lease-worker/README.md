# Lease worker fixture

Synthetic TypeScript source for a queue worker with optimistic lease acquisition.
The in-memory store makes comparison and replacement synchronous between awaits.
It is an example adapter, not a distributed database implementation.

Work may execute twice after a lease expires; a generation check fences completion,
not arbitrary external effects of the job. The worker deliberately has no heartbeat.
