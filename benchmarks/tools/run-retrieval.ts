/**
 * Retrieval benchmark runner (JG-028, specification 11.2).
 *
 * It replays a corpus manifest (JG-027) through the shared engine and records what
 * actually happened: the settings and versions in force, the outcome of every search
 * including partial, empty and failed ones, the response size, the latency, the
 * provider usage that was reported and the usage that stayed unknown.
 *
 * Two deliberate rules:
 *
 * 1. Annotations are a revisable reference, not proof. Evidence recall is measured
 *    against the annotated ranges, and precision is reported as *annotated*
 *    precision, because an unannotated excerpt is not demonstrably useless.
 * 2. Nothing here estimates its way around a missing fact. An attempt whose usage the
 *    provider did not report is counted as unknown, never as zero, and a dollar
 *    figure is only ever labelled an estimate.
 *
 * Provider modes:
 *   --provider live      real Jev evaluation; needs the credential and an explicit
 *                        budget decision by the operator.
 *   --provider offline   a deterministic local scorer used to exercise the runner
 *                        itself. Its numbers measure plumbing, not retrieval quality,
 *                        and the report says so.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { argv, env, hrtime, stdout, versions } from 'node:process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfiguration, createDefaultConfiguration } from '../../src/config.ts';
import type { LoadedConfiguration } from '../../src/config.ts';
import { createSearchEngine } from '../../src/engine.ts';
import { CRITERION_VERSION, LAYOUT_VERSION } from '../../src/evaluation/jev.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../../src/evaluation/jev.ts';
import { REFERENCE_COUNTER_ID } from '../../src/response/token-counter.ts';
import { SYNTAX_CHUNKER_VERSION } from '../../src/source/chunker.ts';
import { LINE_WINDOW_CHUNKER_VERSION } from '../../src/source/line-windows.ts';
import { AuthorizedRoot } from '../../src/source/authorization.ts';
import type { SearchResult } from '../../src/contracts.ts';
import { CorpusValidationError, scoreQuestion, validateManifest } from './corpus-scoring.ts';
import type { CorpusManifest, CorpusQuestion, EvidenceScore } from './corpus-scoring.ts';
import { fixtureTreeHash } from './check-corpus.ts';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export type { CorpusManifest, CorpusQuestion, EvidenceAnnotation } from './corpus-scoring.ts';

export type QuestionOutcome = {
  readonly question_id: string;
  readonly kind: string;
  readonly status: string;
  readonly selection_outcome: string;
  readonly stop_reasons: readonly string[];
  readonly excerpts: number;
  readonly response_tokens: number | null;
  readonly latency_ms: number;
  /** How this question is counted: measured, ambiguous, or a no-evidence control. */
  readonly category: EvidenceScore['category'];
  /** Which annotated set matched best; 0 is the primary set, 1+ are the alternatives. */
  readonly best_evidence_set: number | null;
  readonly evidence_sets: number;
  readonly annotated_evidence: number;
  readonly annotated_evidence_found: number;
  readonly direct_evidence: number;
  readonly direct_evidence_found: number;
  /** Every item of one annotated set was found. */
  readonly complete_set_found: boolean;
  readonly direct_set_found: boolean;
  readonly excerpts_overlapping_annotation: number;
  readonly provider_attempts: number;
  readonly input_tokens_known: number;
  readonly attempts_with_unknown_usage: number;
  readonly estimated_cost_usd: number | null;
  readonly cache_reused: number;
  readonly remote_evaluated: number;
  readonly scope_fully_scanned: boolean;
};

export type BenchmarkRun = {
  readonly manifest: {
    readonly generated_at: string;
    readonly node_version: string;
    readonly provider_mode: 'live' | 'offline';
    readonly cache_state: 'cold' | 'warm';
    readonly counter: string;
    readonly criterion_version: string;
    readonly layout_version: string;
    readonly chunkers: readonly string[];
    readonly settings: Record<string, number | boolean | string>;
    readonly corpus: {
      readonly file: string; readonly split: string; readonly fixture: string; readonly revision: string;
      readonly annotation_revision: string; readonly corpus_commit: string | null;
    };
    readonly caveats: readonly string[];
  };
  readonly questions: readonly QuestionOutcome[];
  readonly summary: Record<string, number | null>;
};

/** Deterministic local scorer: plumbing only, never a retrieval measurement. */
class OfflineLexicalProvider implements ProviderClient {
  readonly model = 'offline-check-1';

  evaluateBatch(batch: EvaluationBatch): Promise<BatchEvaluation> {
    const terms = new Set(batch.query.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const scores = new Map<string, number>();
    for (const item of batch.items) {
      const haystack = `${item.path} ${item.text}`.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          hits += 1;
        }
      }
      scores.set(item.id, terms.size === 0 ? 0 : Math.min(1, hits / terms.size));
    }
    return Promise.resolve({
      scores, invalid: [], usage: { inputTokens: null, outputTokens: null },
      requestedModel: this.model, returnedModel: null,
      transmittedBytes: batch.items.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
      requestId: null,
    });
  }
}

function measureQuestion(
  question: CorpusQuestion,
  result: SearchResult,
  latencyMs: number,
  responseTokens: number | null,
): QuestionOutcome {
  const score = scoreQuestion(question, result.excerpts.map((excerpt) => ({
    path: excerpt.path, startLine: excerpt.start_line, endLine: excerpt.end_line,
  })));

  return {
    question_id: question.id,
    kind: question.kind,
    status: result.status,
    selection_outcome: result.report.selection.outcome,
    stop_reasons: result.report.stop_reasons,
    excerpts: result.excerpts.length,
    response_tokens: responseTokens,
    latency_ms: latencyMs,
    category: score.category,
    best_evidence_set: score.best_set,
    evidence_sets: score.set_count,
    annotated_evidence: score.evidence_items,
    annotated_evidence_found: score.evidence_found,
    direct_evidence: score.direct_items,
    direct_evidence_found: score.direct_found,
    complete_set_found: score.complete_set_found,
    direct_set_found: score.direct_set_found,
    excerpts_overlapping_annotation: score.excerpts_overlapping_annotation,
    provider_attempts: result.report.usage.provider_request_attempts,
    input_tokens_known: result.report.usage.provider_input_tokens_known_subtotal,
    attempts_with_unknown_usage: result.report.usage.attempts_with_unknown_usage,
    estimated_cost_usd: result.report.usage.estimated_cost_usd,
    cache_reused: result.report.fragments.cache_reused,
    remote_evaluated: result.report.fragments.remote_evaluated,
    scope_fully_scanned: result.report.scope_fully_scanned,
  };
}

function quantile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

/**
 * Aggregate the run.
 *
 * Three populations are kept apart because they answer different questions: measured
 * questions, questions the corpus marks ambiguous, and no-evidence controls whose
 * correct outcome is an empty selection. Mixing them would let a control inflate
 * recall or an ambiguity depress it.
 */
export function summarize(outcomes: readonly QuestionOutcome[]): Record<string, number | null> {
  const latencies = outcomes.map((outcome) => outcome.latency_ms);
  const tokens = outcomes.map((outcome) => outcome.response_tokens).filter((value): value is number => value !== null);
  const scored = outcomes.filter((outcome) => outcome.category === 'scored');
  const ambiguous = outcomes.filter((outcome) => outcome.category === 'ambiguous');
  const controls = outcomes.filter((outcome) => outcome.category === 'no_evidence_control');

  const ratio = (found: number, total: number): number | null => (total === 0 ? null : Number((found / total).toFixed(4)));
  const sum = (rows: readonly QuestionOutcome[], pick: (row: QuestionOutcome) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);

  const returned = sum(scored, (row) => row.excerpts);
  const overlapping = sum(scored, (row) => row.excerpts_overlapping_annotation);

  return {
    questions: outcomes.length,
    complete: outcomes.filter((outcome) => outcome.status === 'complete').length,
    partial: outcomes.filter((outcome) => outcome.status === 'partial').length,
    rejected: outcomes.filter((outcome) => outcome.status === 'rejected').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    empty_selections: outcomes.filter((outcome) => outcome.excerpts === 0).length,

    scored_questions: scored.length,
    complete_evidence_sets: scored.filter((outcome) => outcome.complete_set_found).length,
    complete_evidence_set_rate: ratio(scored.filter((outcome) => outcome.complete_set_found).length, scored.length),
    direct_evidence_sets_found: scored.filter((outcome) => outcome.direct_set_found).length,
    evidence_recall: ratio(sum(scored, (row) => row.annotated_evidence_found), sum(scored, (row) => row.annotated_evidence)),
    direct_evidence_recall: ratio(sum(scored, (row) => row.direct_evidence_found), sum(scored, (row) => row.direct_evidence)),
    annotated_precision: ratio(overlapping, returned),
    questions_using_an_alternative_set: scored.filter((outcome) => (outcome.best_evidence_set ?? 0) > 0).length,

    ambiguous_questions: ambiguous.length,
    ambiguous_complete_evidence_sets: ambiguous.filter((outcome) => outcome.complete_set_found).length,
    ambiguous_evidence_recall: ratio(sum(ambiguous, (row) => row.annotated_evidence_found), sum(ambiguous, (row) => row.annotated_evidence)),

    no_evidence_controls: controls.length,
    no_evidence_controls_answered_empty: controls.filter((outcome) => outcome.excerpts === 0 && outcome.status === 'complete' && outcome.scope_fully_scanned).length,
    no_evidence_controls_unevaluable: controls.filter((outcome) => outcome.status !== 'complete' || !outcome.scope_fully_scanned).length,
    no_evidence_controls_with_excerpts: controls.filter((outcome) => outcome.excerpts > 0).length,

    median_latency_ms: quantile(latencies, 0.5),
    p90_latency_ms: quantile(latencies, 0.9),
    median_response_tokens: quantile(tokens, 0.5),
    max_response_tokens: tokens.length === 0 ? null : Math.max(...tokens),
    provider_attempts: sum(outcomes, (row) => row.provider_attempts),
    attempts_with_unknown_usage: sum(outcomes, (row) => row.attempts_with_unknown_usage),
    input_tokens_known: sum(outcomes, (row) => row.input_tokens_known),
    cache_reused_fragments: sum(outcomes, (row) => row.cache_reused),
  };
}

export type RunOptions = {
  readonly manifestPath: string;
  readonly providerMode: 'live' | 'offline';
  readonly cacheState: 'cold' | 'warm';
  readonly configuration?: LoadedConfiguration;
  readonly threshold?: number;
};

/** Replay one manifest and return its recorded run. */
export async function runManifest(options: RunOptions): Promise<BenchmarkRun> {
  let parsed: unknown;
  let annotationRevision: string;
  try {
    const bytes = readFileSync(options.manifestPath);
    parsed = JSON.parse(bytes.toString('utf8'));
    annotationRevision = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (cause) {
    throw new CorpusValidationError(options.manifestPath, cause instanceof Error ? cause.message : 'unreadable manifest');
  }
  // The held-out refusal comes before validation: which split a file belongs to is a
  // policy gate, and a held-out manifest deliberately keeps its answers (and its
  // budget block) outside this checkout, so schema complaints would only obscure it.
  const declaredSplit = (parsed as { split?: unknown } | null)?.split;
  if (declaredSplit !== 'development') {
    throw new Error(`this development runner cannot execute held-out data (split: ${String(declaredSplit)}); `
      + 'JG-028/JG-029 require an isolated executor');
  }
  const manifest = validateManifest(parsed, options.manifestPath);
  const fixtureRoot = resolve(repositoryRoot, 'benchmarks', 'fixtures', manifest.fixture.id);
  const authorized = AuthorizedRoot.open(fixtureRoot);
  if (manifest.fixture.revision.kind !== 'tree-sha256' || fixtureTreeHash(authorized.path) !== manifest.fixture.revision.value) {
    throw new CorpusValidationError(options.manifestPath, 'fixture revision is stale; re-review annotations before measuring');
  }
  if (options.configuration !== undefined && options.configuration.repositoryRoot !== authorized.path) {
    throw new CorpusValidationError(options.manifestPath, 'the trusted configuration authorizes a different fixture');
  }
  const temporary = options.configuration === undefined ? temporaryConfiguration(fixtureRoot, options) : undefined;
  const coldCache = options.cacheState === 'cold' ? mkdtempSync(join(tmpdir(), 'jevgrep-benchmark-cache-')) : undefined;
  try {
    const configuration = options.configuration ?? temporary!.configuration;
    return await runConfiguredManifest(options, manifest, coldCache === undefined ? configuration : { ...configuration, cacheDirectory: coldCache }, annotationRevision);
  } finally {
    temporary?.cleanup();
    if (coldCache !== undefined) rmSync(coldCache, { recursive: true, force: true });
  }
}

async function runConfiguredManifest(options: RunOptions, manifest: CorpusManifest, configuration: LoadedConfiguration, annotationRevision: string): Promise<BenchmarkRun> {
  const provider = options.providerMode === 'offline' ? new OfflineLexicalProvider() : undefined;
  const engine = createSearchEngine({
    configuration,
    ...(provider === undefined ? {} : { provider }),
    env: options.providerMode === 'offline' ? {} : env,
  });

  if (options.cacheState === 'cold') {
    engine.cache.clear();
    if (engine.cache.stats.failures > 0) throw new Error('cannot establish an empty cold cache; benchmark refused');
  }

  const outcomes: QuestionOutcome[] = [];
  for (const question of manifest.questions) {
    const started = hrtime.bigint();
    const { outcome, measuredTokens } = await engine.search({
      query: question.question,
      scope: [...question.scope],
      max_context_tokens: manifest.budget.max_context_tokens,
      allow_partial_scan: manifest.budget.allow_partial_scan,
    });
    const latencyMs = Number((hrtime.bigint() - started) / 1_000_000n);

    if (!('report' in outcome)) {
      // A compact error still occupies its row: a refused search is a result of the
      // run, and scoring it against zero returned ranges keeps the categories honest.
      const score = scoreQuestion(question, []);
      outcomes.push({
        question_id: question.id, kind: question.kind, status: outcome.status,
        selection_outcome: `error:${outcome.error.code}`, stop_reasons: [outcome.error.code],
        excerpts: 0, response_tokens: measuredTokens, latency_ms: latencyMs,
        category: score.category, best_evidence_set: score.best_set, evidence_sets: score.set_count,
        annotated_evidence: score.evidence_items, annotated_evidence_found: 0,
        direct_evidence: score.direct_items, direct_evidence_found: 0,
        complete_set_found: false, direct_set_found: false, excerpts_overlapping_annotation: 0,
        provider_attempts: 0, input_tokens_known: 0, attempts_with_unknown_usage: 0,
        estimated_cost_usd: null, cache_reused: 0, remote_evaluated: 0, scope_fully_scanned: false,
      });
      continue;
    }
    outcomes.push(measureQuestion(question, outcome, latencyMs, measuredTokens));
  }

  const caveats = [
    'complete evidence sets means full annotated line coverage, not a semantic correctness or task-success judgment; disputed outputs need review',
    'annotations are an incomplete, revisable reference: an unannotated excerpt is not proven useless',
    'recall is measured against the best matching annotated set; alternative sets are separate valid answers, not one larger set',
    'ambiguous questions and no-evidence controls are reported apart from the headline metrics',
    'dollar figures are estimates from a dated rate card, never an invoice',
    'attempts whose usage the provider did not report are counted as unknown, not as zero',
  ];
  if (options.providerMode === 'offline') {
    caveats.unshift('OFFLINE MODE: scores come from a deterministic local scorer; these numbers exercise the runner, they do not measure Jev retrieval quality');
    caveats.push('the offline scorer has no qualified pinned provider revision and cannot exercise persistent cache reuse; warm is a requested cache policy, not a claim of cache hits');
  }

  return {
    manifest: {
      generated_at: new Date().toISOString(),
      node_version: versions.node,
      provider_mode: options.providerMode,
      cache_state: options.cacheState,
      counter: REFERENCE_COUNTER_ID,
      criterion_version: CRITERION_VERSION,
      layout_version: LAYOUT_VERSION,
      chunkers: [SYNTAX_CHUNKER_VERSION, LINE_WINDOW_CHUNKER_VERSION],
      settings: {
        threshold: configuration.config.search.threshold,
        max_context_tokens: manifest.budget.max_context_tokens,
        allow_partial_scan: manifest.budget.allow_partial_scan,
        concurrency: configuration.config.search.concurrency,
        deadline_ms: configuration.config.search.deadline_ms,
        max_file_bytes: configuration.config.source.max_file_bytes,
        configuration_fingerprint: configuration.fingerprint,
        provider_adapter: configuration.config.provider.adapter ?? 'typesafe-direct',
        provider_model: configuration.config.provider.model,
        scan_caps: JSON.stringify(configuration.config.scan_caps),
      },
      corpus: {
        file: basename(options.manifestPath),
        split: manifest.split,
        fixture: manifest.fixture.id,
        revision: `${manifest.fixture.revision.kind}:${manifest.fixture.revision.value}`,
        annotation_revision: annotationRevision,
        corpus_commit: corpusCommit(),
      },
      caveats,
    },
    questions: outcomes,
    summary: summarize(outcomes),
  };
}

function corpusCommit(): string | null {
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', timeout: 2_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40,64}$/.test(value) ? value : null;
  } catch { return null; }
}

/**
 * A throwaway trusted configuration for a fixture.
 *
 * It lives in a temporary directory, never inside the searched fixture and never
 * inside the project tree: a configuration a repository could edit would not be
 * trusted (specification 5.1).
 */
function temporaryConfiguration(fixtureRoot: string, options: RunOptions): { configuration: LoadedConfiguration; cleanup(): void } {
  const workspace = mkdtempSync(join(tmpdir(), 'jevgrep-benchmark-'));
  const base = createDefaultConfiguration(fixtureRoot.split('\\').join('/'), 'jev-1.13.0');
  const config = {
    ...base,
    remote_evaluation_enabled: options.providerMode === 'live',
    search: { ...base.search, ...(options.threshold === undefined ? {} : { threshold: options.threshold }) },
  };
  const configPath = join(workspace, `${basename(fixtureRoot)}.config.json`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const configuration = loadConfiguration(configPath, { env: options.providerMode === 'offline' ? { JEVGREP_CACHE_HOME: join(workspace, 'cache') } : env });
  return { configuration, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

/** Markdown summary; the JSON run stays the record of truth. */
export function renderRun(run: BenchmarkRun): string {
  const lines = [
    `# Retrieval run — ${run.manifest.corpus.fixture} (${run.manifest.corpus.split})`,
    '',
    `Generated ${run.manifest.generated_at} on Node ${run.manifest.node_version}.`,
    `Provider mode: **${run.manifest.provider_mode}**. Cache: **${run.manifest.cache_state}**.`,
    `Counter ${run.manifest.counter}; criterion ${run.manifest.criterion_version}; layout ${run.manifest.layout_version}.`,
    `Corpus revision ${run.manifest.corpus.revision}.`,
    `Annotations ${run.manifest.corpus.annotation_revision}; corpus commit ${run.manifest.corpus.corpus_commit ?? 'unavailable'}.`,
    '',
    '## Settings in force',
    '',
    ...Object.entries(run.manifest.settings).map(([key, value]) => `- ${key}: ${String(value)}`),
    '',
    '## Summary',
    '',
    '| metric | value |',
    '| --- | --- |',
    ...Object.entries(run.summary).map(([key, value]) => `| ${key} | ${value === null ? 'unknown' : String(value)} |`),
    '',
    '## Caveats',
    '',
    ...run.manifest.caveats.map((caveat) => `- ${caveat}`),
    '',
    '## Per-question outcomes',
    '',
    '| question | category | status | selection | excerpts | evidence found | complete set | response tokens | latency ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...run.questions.map((question) => `| ${question.question_id} | ${question.category} | ${question.status} `
      + `| ${question.selection_outcome} | ${String(question.excerpts)} `
      + `| ${String(question.annotated_evidence_found)}/${String(question.annotated_evidence)}`
      + `${(question.best_evidence_set ?? 0) > 0 ? ` (set ${String(question.best_evidence_set)})` : ''} `
      + `| ${question.category === 'no_evidence_control' ? 'n/a' : question.complete_set_found ? 'yes' : 'no'} `
      + `| ${question.response_tokens === null ? 'unknown' : String(question.response_tokens)} | ${String(question.latency_ms)} |`),
    '',
  ];
  return lines.join('\n');
}

function parseArguments(args: readonly string[]): { manifests: string[]; providerMode: 'live' | 'offline'; cacheState: 'cold' | 'warm'; out: string | null } {
  const manifests: string[] = [];
  let providerMode: 'live' | 'offline' = 'offline';
  let cacheState: 'cold' | 'warm' = 'cold';
  let out: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--manifest' && value !== undefined) {
      manifests.push(value);
      index += 1;
    } else if (argument === '--provider' && (value === 'live' || value === 'offline')) {
      providerMode = value;
      index += 1;
    } else if (argument === '--cache' && (value === 'cold' || value === 'warm')) {
      cacheState = value;
      index += 1;
    } else if (argument === '--out' && value !== undefined) {
      out = value;
      index += 1;
    }
  }
  return { manifests, providerMode, cacheState, out };
}

if (import.meta.url === `file://${resolve(argv[1] ?? '').split('\\').join('/')}`
  || (argv[1] !== undefined && basename(argv[1]) === 'run-retrieval.ts')) {
  const options = parseArguments(argv.slice(2));
  const manifests = options.manifests.length > 0
    ? options.manifests
    : [join(repositoryRoot, 'benchmarks', 'manifests', 'development', 'subscription-cache.development.json')];

  for (const [manifestIndex, manifestPath] of manifests.entries()) {
    const run = await runManifest({
      manifestPath: resolve(manifestPath),
      providerMode: options.providerMode,
      cacheState: options.cacheState,
    });
    if (options.out === null) {
      stdout.write(`${renderRun(run)}\n`);
    } else {
      mkdirSync(dirname(resolve(options.out)), { recursive: true });
      const stem = resolve(options.out).replace(/\.(json|md)$/, '')
        + (manifests.length > 1 ? `-${String(manifestIndex + 1)}-${run.manifest.corpus.fixture}` : '');
      writeFileSync(`${stem}.json`, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      writeFileSync(`${stem}.md`, renderRun(run), 'utf8');
      stdout.write(`wrote ${stem}.json and ${stem}.md\n`);
    }
  }
}
