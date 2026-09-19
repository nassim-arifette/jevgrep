# orders-api runbook

## Deploy

1. Apply migrations in order (`npm run migrate`).
2. Restart the service; the health endpoint `/health/ready` must return `ready`.
3. Watch the `role rejected` and `rate_limited` log lines for ten minutes.

## Incident: elevated 403 responses

Check `src/middleware/authenticate.ts` first: a role-order change or an expired session
map turns every privileged call into a 403. Confirm with the `role rejected` log entries,
which include the current and required role.

## Incident: cancelled orders keep reserving stock

`InventoryService.release` is called by the cancellation pipeline after the database
update; if reservations stay behind, inspect the reservation TTL
(`orders.reservation_ttl_seconds`) before touching the order rows.
