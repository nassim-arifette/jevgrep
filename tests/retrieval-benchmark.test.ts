import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { renderRun, runManifest, summarize } from '../benchmarks/tools/run-retrieval.ts';
import type { CorpusManifest, QuestionOutcome } from '../benchmarks/tools/run-retrieval.ts';
import { ScoreCache } from '../src/evaluation/cache.ts';

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

test('a failure to establish the isolated cold cache refuses the run instead of mislabeling it', async (t) => {
  t.mock.method(ScoreCache.prototype, 'clear', function (this: ScoreCache) { this.stats.failures++; return 0; });
  await assert.rejects(runManifest({ manifestPath: manifestPath(firstManifest), providerMode: 'offline', cacheState: 'cold' }), /cold cache.*refused/);
});

test('headline precision excludes other populations and a failed negative is never a success', () => {
  const row: QuestionOutcome = {
    question_id: 'q', kind: 'behavior', status: 'complete', selection_outcome: 'selected', stop_reasons: [],
    excerpts: 1, response_tokens: 1000, latency_ms: 1, category: 'scored', best_evidence_set: 0, evidence_sets: 1,
    annotated_evidence: 1, annotated_evidence_found: 1, direct_evidence: 1, direct_evidence_found: 1,
    complete_set_found: true, direct_set_found: true, excerpts_overlapping_annotation: 1,
    provider_attempts: 1, input_tokens_known: 10, attempts_with_unknown_usage: 0, estimated_cost_usd: null,
    cache_reused: 0, remote_evaluated: 1, scope_fully_scanned: true,
  };
  const control = { ...row, category: 'no_evidence_control', kind: 'no_evidence', excerpts: 0, excerpts_overlapping_annotation: 0 } as const;
  const summary = summarize([row, { ...row, category: 'ambiguous', excerpts: 20, excerpts_overlapping_annotation: 0 },
    control, { ...control, status: 'error', scope_fully_scanned: false }, { ...control, status: 'partial', scope_fully_scanned: false },
    { ...control, status: 'rejected', scope_fully_scanned: false }]);
  assert.equal(summary['annotated_precision'], 1);
  assert.equal(summary['no_evidence_controls_answered_empty'], 1);
  assert.equal(summary['no_evidence_controls_unevaluable'], 3);
});

test('a stale fixture revision is refused before any engine or provider work', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'jevgrep-stale-manifest-'));
  try {
    const manifest = JSON.parse(readFileSync(manifestPath(firstManifest), 'utf8')) as CorpusManifest;
    const stale = { ...manifest, fixture: { ...manifest.fixture, revision: { kind: 'tree-sha256', value: '0'.repeat(64) } } };
    const path = join(temporary, 'stale.json'); writeFileSync(path, JSON.stringify(stale));
    await assert.rejects(runManifest({ manifestPath: path, providerMode: 'live', cacheState: 'cold' }), /revision is stale/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('live benchmarking is available and still validates the corpus before provider work', async () => {
  await assert.rejects(runManifest({
    manifestPath: 'not-a-file.json', providerMode: 'live', cacheState: 'cold',
  }), /not-a-file\.json/);
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
  assert.equal(run.manifest.corpus.annotation_revision, `sha256:${createHash('sha256').update(readFileSync(manifestPath(firstManifest))).digest('hex')}`);
  assert.ok(run.manifest.corpus.corpus_commit === null || /^[0-9a-f]{40,64}$/.test(run.manifest.corpus.corpus_commit));
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

  // The three populations partition the questions: measured, ambiguous, control.
  const populations = (run.summary['scored_questions'] ?? 0)
    + (run.summary['ambiguous_questions'] ?? 0) + (run.summary['no_evidence_controls'] ?? 0);
  assert.equal(populations, manifest.questions.length, 'no question falls outside its population');
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
  assert.ok(report.includes('| question | category | status |'), 'the table names the population of each question');
  assert.ok(report.includes('recall is measured against the best matching annotated set'));
  assert.ok(report.includes('ambiguous questions and no-evidence controls are reported apart'));
  for (const question of run.questions) {
    if (question.response_tokens !== null) {
      assert.ok(
        question.response_tokens <= manifest.budget.max_context_tokens,
        `${question.question_id} exceeded its declared response budget`,
      );
    }
  }
});
