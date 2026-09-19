# JG-004 contract probe

This is a separate experiment package. The SDK is pinned to `@typesafe-ai/sdk@0.6.0`
and does not become a production dependency. Install from the committed lockfile:

```bash
npm ci --prefix experiments/jev-contract --ignore-scripts --no-audit --no-fund
npm test --prefix experiments/jev-contract
```

The 14 tests launch a fresh Node process for each of seven cases, once through the
SDK and once through native fetch: healthy response, 429, 500, connection loss,
pre-dispatch abort, abort after headers with an unfinished body, and body timeout.
Each worker accepts only its own loopback URL and uses synthetic credentials/body.
Ambient debug logging and provider URL/model settings are deliberately hostile;
explicit settings must prevail. No provider or other external endpoint is contacted.
An abnormal exit, extra dispatch, log leak or hung child fails the test.

The tests require local loopback sockets; they are intentionally separate from the
ordinary network-forbidden unit suite. Their timeouts are experimental guards, not
product defaults or account limits.

## Live smoke probe

Provision `TYPESAFE_API_KEY` in the operator process, then opt in explicitly:

```bash
node experiments/jev-contract/probe.mjs --live
```

The command submits **one potentially billable request with two synthetic questions**,
retries disabled, a fixed endpoint/model, and a ten-second deadline. Redirects are
refused. Without the flag or credential it emits `not_dispatched` and exits 2.
It does not read repository files, save raw bodies, print the credential, or use an
ambient provider base URL. Its single JSON record contains allowlisted observations
only; errors and missing usage are not converted to zero usage. The two scores are
observations, not a retrieval-quality gate.

The SDK buffers a response before parsing it. This probe is not the production
adapter and does not claim bounded response bytes or duplicate-key detection.
Capacity limits, live cancellation/billing, account pricing and batching independence
need separate experiments. See [the evidence report](../../docs/reports/jg-004-offline-sdk.md).
