# orders-api fixture

Small synthetic order-management service used as searchable material for the JevGrep
retrieval corpus ([JG-027](../../../docs/issues.md#jg-027)).

It is **not built, executed or installed** by JevGrep or by its test suite: the files are
read-only source material for search questions. The code is written to be realistic for a
TypeScript/Express service, not to run.

Layout: HTTP routes, middleware, services, a small library layer, SQL migrations, ADR and
runbook docs, and tests with a fake database.

Ownership: authored inside this repository for the corpus. No third-party code, no copied
licence-bearing content (see `LICENSE`).
