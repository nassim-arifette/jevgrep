# ADR 0001: use PostgreSQL with hand-written SQL

Status: accepted (2025-11-03)

## Context

Order state, reservations and discount codes change often, and the team already runs
PostgreSQL for the billing service. An earlier prototype used an ORM with SQLite for
local development, which drifted from production behaviour: the ORM generated different
locking semantics and hid the statement timeout that production relies on.

## Decision

Use PostgreSQL in every environment, including tests, with hand-written SQL statements in
the service layer. Tests use a fake pool, and migration files under `migrations/` are
applied in order.

## Consequences

- Query plans and statement timeouts behave the same locally and in production.
- SQL is explicit and reviewable, but every new query must be tested against the fake pool.
- No ORM layer means no automatic schema sync; migrations are mandatory.
