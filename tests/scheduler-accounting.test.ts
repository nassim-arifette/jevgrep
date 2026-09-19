import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSearchEngine } from '../src/engine.ts';
import { ProviderError, type ProviderClient } from '../src/evaluation/jev.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

for (const cap of [null, 1]) {
  test(`retry accounting retains unknown usage and obeys attempt cap ${String(cap)}`, async () => {
    const space = createWorkspace({ files: { 'a.ts': 'export const a = 1;\n' }, configure: (config) => ({
      ...withRemoteEnabled(config), scan_caps: { ...config.scan_caps, request_attempts: cap },
      search: { ...config.search, retry: { max_retries: 2, base_delay_ms: 1, max_delay_ms: 1, retry_ambiguous: false } },
    }) });
    try {
      let calls = 0;
      const provider: ProviderClient = { model: 'jev-1.13.0', async evaluateBatch(batch) {
        if (++calls === 1) throw new ProviderError({ code: 'PROVIDER_RATE_LIMIT', message: 'refused', retryable: true, ambiguous: false });
        return { scores: new Map(batch.items.map((item) => [item.id, 0.9])), invalid: [],
          usage: { inputTokens: 100, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
          transmittedBytes: 0, requestId: null };
      } };
      const { outcome } = await createSearchEngine({ configuration: space.loaded, provider }).search({ query: 'a', scope: ['.'] });
      assert.ok('report' in outcome);
      assert.equal(calls, cap === null ? 2 : 1);
      assert.equal(outcome.report.usage.provider_request_attempts, calls);
      assert.equal(outcome.report.usage.attempts_with_unknown_usage, 1);
      assert.equal(outcome.report.usage.provider_input_tokens_reported, null);
      assert.ok(outcome.report.usage.provider_input_tokens_estimated > outcome.report.usage.provider_input_tokens_known_subtotal);
      assert.equal(outcome.report.fragments.remote_evaluated, cap === null ? 1 : 0);
      assert.equal(outcome.status, cap === null ? 'complete' : 'partial');
      if (cap === 1) assert.ok(outcome.report.stop_reasons.includes('SCAN_CAP_REACHED'));
    } finally { space.cleanup(); }
  });
}
