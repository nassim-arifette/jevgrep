# JG-004 — observed offline SDK behavior

Executed 2026-09-19 on Windows, Node **24.15.0**, npm **11.12.1**, official
`@typesafe-ai/sdk@0.6.0`. Exact archive integrity is recorded in the separate
[experiment lockfile](../../experiments/jev-contract/package-lock.json).
This qualifies selected local SDK behavior, not the live Jev service or account.

Commands:

```bash
npm ci --prefix experiments/jev-contract --ignore-scripts --no-audit --no-fund
npm test --prefix experiments/jev-contract
node experiments/jev-contract/probe.mjs
```

The 14 child-process cases passed (seven SDK, seven native fetch). A local HTTP server
returned synthetic responses; transport was restricted to its exact loopback endpoint.
The no-flag probe exits 2 with `not_dispatched`; it submits no provider request.

| Observation | Result |
| --- | --- |
| Success / reversed answer-key order | Keys, Noul values, model and integer usage preserved. |
| HTTP 429 and 500 | Exactly one dispatch with `retry.maxRetries = 0`; handled failure. |
| Connection loss | Exactly one dispatch; handled failure. |
| Already-aborted signal | Zero requests reached the server. |
| Caller abort after headers, body pending | Handled rejection; child exited normally. |
| Timeout after headers, body pending | Handled rejection; child exited normally. |
| Ambient debug logging | Explicit `logLevel: off` kept stdout/stderr free of body/key sentinels. |
| Ambient base URL/model | Explicit values selected the local fixture and requested model. |

The native-fetch comparison exhibited the same tested observable behavior. There was
no demonstrated cancellation failure requiring a workaround on this runtime/version.
These tests do not establish behavior under every network failure or Node version.

The [live probe](../../experiments/jev-contract/probe.mjs) is implemented and syntactically
checked. It fixes endpoint/model, refuses redirects, requires explicit opt-in and emits
only allowlisted metadata, scores and usage. **It was not dispatched:** this environment
has no configured provider credential. No successful authentication, account-visible
resolved model, real usage, capacity boundary, provider cancellation or billing was
observed. The provider-case table remains open for those live observations.

JG-004 remains in progress. JG-005 remains blocked on the live capabilities and its own
predeclared layout comparison. SDK parsing still needs production validation and a
response byte cap; raw duplicate keys are lost by ordinary JSON parsing. The source
basis and documented limits are in [the contract research](../research/jev-contract-update.md).
