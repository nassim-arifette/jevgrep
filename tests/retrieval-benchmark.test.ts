import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { renderRun, runManifest } from '../benchmarks/tools/run-retrieval.ts';
import type { CorpusManifest } from '../benchmarks/tools/run-retrieval.ts';

/**
 * The retrieval benchmark runner (JG-028, specification 11.2).
 *
 * The runner is the measurement instrument, so the tests check the instrument: every
 * run carries a manifest that makes it reproducible, cold and warm cache runs stay
 * separate, empty and failed searches are counted rather than dropped, and unknown
 * provider usage is never reported as a cost of zero.
 *
 * The provider mode used here is the offline scorer: these assertions are about the
 * runner, never about Jev's retrieval quality.
 */
const developmentDirectory = fileURLToPath(new URL('../benchmarks/manifests/development/', import.meta.url));

function manifestPath(name: string): string {
  return `${developmentDirectory}${name}`;
}

const firstManifest = readdirSync(developmentDirectory).filter((name) => name.endsWith('.json')).sort()[0] ?? '';

test('live benchmarking is blocked before any corpus or credential is read', async () => {
  await assert.rejects(runManifest({
    manifestPath: 'not-a-file.json', providerMode: 'live', cacheState: 'cold',
  }), /live search is not qualified/);
});

test('the development runner refuses held-out manifests', async () => {
  const directory = fileURLToPath(new URL('../benchmarks/manifests/holdout/', import.meta.url));
  const name = readdirSync(directory).find((entry) => entry.endsWith('.json'));
  assert.ok(name);
  await assert.rejects(runManifest({
    manifestPath: `${directory}${name}`, providerMode: 'offline', cacheState: 'cold',
  }), /cannot execute held-out/);
});

test('a run records the settings, versions and corpus revision that produced it', async () => {
  const run = await runManifest({
    manifestPath: manifestPath(firstManifest), providerMode: 'offline', cacheState: 'cold',
  });

  assert.equal(run.manifest.provider_mode, 'offline');
  assert.equal(run.manifest.cache_state, 'cold');
  assert.equal(run.manifest.counter, 'tiktoken@1.0.22/cl100k_base');
  assert.ok(run.manifest.criterion_version.length > 0);
  assert.ok(run.manifest.layout_version.length > 0);
  assert.ok(run.manifest.chunkers.length >= 1);
  assert.ok(run.manifest.corpus.revision.includes(':'), 'the corpus revision is recorded with its kind');
  assert.equal(typeof run.manifest.settings['threshold'], 'number');
  assert.equal(typeof run.manifest.settings['configuration_fingerprint'], 'string');
  assert.ok(run.manifest.caveats.some((caveat) => caveat.includes('OFFLINE MODE')));
});

test('every question of the manifest appears in the results, including empty selections', async () => {
  const path = manifestPath(firstManifest);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as CorpusManifest;
  const run = await runManifest({ manifestPath: path, providerMode: 'offline', cacheState: 'cold' });

  assert.equal(run.questions.length, manifest.questions.length);
  assert.deepEqual(
    run.questions.map((question) => question.question_id).sort(),
    manifest.questions.map((question) => question.id).sort(),
  );
  assert.equal(run.summary['questions'], manifest.questions.length);
  const accounted = (run.summary['complete'] ?? 0) + (run.summary['partial'] ?? 0)
    + (run.summary['rejected'] ?? 0) + (run.summary['failed'] ?? 0);
  assert.equal(accounted, manifest.questions.length, 'no search is dropped from the report');
  assert.ok((run.summary['empty_selections'] ?? 0) >= 0);
});

test('unknown provider usage is reported as unknown, never as a zero cost', async () => {
  const run = await runManifest({
    manifestPath: manifestPath(firstManifest), providerMode: 'offline', cacheState: 'cold',
  });
  assert.ok((run.summary['attempts_with_unknown_usage'] ?? 0) > 0, 'the offline scorer reports no usage');
  assert.equal(run.summary['input_tokens_known'], 0);
  for (const question of run.questions) {
    assert.equal(question.estimated_cost_usd, null, 'no dated rate card means no dollar figure at all');
  }
});

test('cold and warm cache runs are separate results', async () => {
  const path = manifestPath(firstManifest);
  const cold = await runManifest({ manifestPath: path, providerMode: 'offline', cacheState: 'cold' });
  const warm = await runManifest({ manifestPath: path, providerMode: 'offline', cacheState: 'warm' });

  assert.equal(cold.manifest.cache_state, 'cold');
  assert.equal(warm.manifest.cache_state, 'warm');
  assert.equal(cold.summary['cache_reused_fragments'], 0, 'a cold run starts from an empty cache');
  assert.equal(
    cold.questions.map((question) => question.excerpts).join(','),
    warm.questions.map((question) => question.excerpts).join(','),
    'reuse changes the accounting, never the selected evidence',
  );
});

test('the same corpus and settings produce the same functional outcomes', async () => {
  const path = manifestPath(firstManifest);
  const first = await runManifest({ manifestPath: path, providerMode: 'offline', cacheState: 'cold' });
  const second = await runManifest({ manifestPath: path, providerMode: 'offline', cacheState: 'cold' });

  const comparable = (run: Awaited<ReturnType<typeof runManifest>>): unknown => run.questions.map((question) => ({
    id: question.question_id,
    status: question.status,
    excerpts: question.excerpts,
    selection: question.selection_outcome,
    recall: question.annotated_evidence_found,
  }));
  // UUIDs and measured elapsed time are serialized, so complete-payload token counts vary.
  assert.deepEqual(comparable(first), comparable(second));
  assert.equal(first.summary['evidence_recall'], second.summary['evidence_recall']);
});

test('the rendered report states its caveats and keeps every response inside its budget', async () => {
  const path = manifestPath(firstManifest);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as CorpusManifest;
  const run = await runManifest({ manifestPath: path, providerMode: 'offline', cacheState: 'cold' });
  const report = renderRun(run);

  assert.ok(report.includes('## Caveats'));
  assert.ok(report.includes('annotations are an incomplete, revisable reference'));
  assert.ok(report.includes('| question | status |'));
  for (const question of run.questions) {
    if (question.response_tokens !== null) {
      assert.ok(
        question.response_tokens <= manifest.budget.max_context_tokens,
        `${question.question_id} exceeded its declared response budget`,
      );
    }
  }
});
