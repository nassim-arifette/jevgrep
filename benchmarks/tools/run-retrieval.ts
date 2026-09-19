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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { argv, env, hrtime, stdout, versions } from 'node:process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfiguration, createDefaultConfiguration } from '../../src/config.ts';
import type { LoadedConfiguration } from '../../src/config.ts';
import { createSearchEngine } from '../../src/engine.ts';
import { requireQualifiedLiveSearch } from '../../src/readiness.ts';
import { CRITERION_VERSION, LAYOUT_VERSION } from '../../src/evaluation/jev.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../../src/evaluation/jev.ts';
import { REFERENCE_COUNTER_ID } from '../../src/response/token-counter.ts';
import { SYNTAX_CHUNKER_VERSION } from '../../src/source/chunker.ts';
import { LINE_WINDOW_CHUNKER_VERSION } from '../../src/source/line-windows.ts';
import type { SearchResult } from '../../src/contracts.ts';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

export type EvidenceAnnotation = {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly role: 'direct' | 'supporting';
  readonly note?: string;
};

export type CorpusQuestion = {
  readonly id: string;
  readonly kind: string;
  readonly question: string;
  readonly scope: readonly string[];
  readonly expected_evidence: readonly EvidenceAnnotation[];
  readonly ambiguous?: boolean;
};

export type CorpusManifest = {
  readonly schema_version: number;
  readonly fixture: {
    readonly id: string;
    readonly revision: { readonly kind: string; readonly value: string };
    readonly license?: string;
  };
  readonly split: string;
  readonly budget: { readonly max_context_tokens: number; readonly allow_partial_scan: boolean };
  readonly questions: readonly CorpusQuestion[];
};

export type QuestionOutcome = {
  readonly question_id: string;
  readonly kind: string;
  readonly status: string;
  readonly selection_outcome: string;
  readonly stop_reasons: readonly string[];
  readonly excerpts: number;
  readonly response_tokens: number | null;
  readonly latency_ms: number;
  readonly annotated_evidence: number;
  readonly annotated_evidence_found: number;
  readonly direct_evidence: number;
  readonly direct_evidence_found: number;
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
    readonly corpus: { readonly file: string; readonly split: string; readonly fixture: string; readonly revision: string };
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

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function measureQuestion(question: CorpusQuestion, result: SearchResult, latencyMs: number, responseTokens: number | null): QuestionOutcome {
  const excerpts = result.excerpts.map((excerpt) => ({
    path: excerpt.path, start: excerpt.start_line, end: excerpt.end_line,
  }));
  const annotated = question.expected_evidence;
  const found = annotated.filter((evidence) => excerpts.some((excerpt) => excerpt.path === evidence.path
    && overlaps({ start: excerpt.start, end: excerpt.end }, { start: evidence.start_line, end: evidence.end_line })));
  const direct = annotated.filter((evidence) => evidence.role === 'direct');
  const directFound = found.filter((evidence) => evidence.role === 'direct');
  const overlapping = excerpts.filter((excerpt) => annotated.some((evidence) => evidence.path === excerpt.path
    && overlaps({ start: excerpt.start, end: excerpt.end }, { start: evidence.start_line, end: evidence.end_line })));

  return {
    question_id: question.id,
    kind: question.kind,
    status: result.status,
    selection_outcome: result.report.selection.outcome,
    stop_reasons: result.report.stop_reasons,
    excerpts: result.excerpts.length,
    response_tokens: responseTokens,
    latency_ms: latencyMs,
    annotated_evidence: annotated.length,
    annotated_evidence_found: found.length,
    direct_evidence: direct.length,
    direct_evidence_found: directFound.length,
    excerpts_overlapping_annotation: overlapping.length,
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

function summarize(outcomes: readonly QuestionOutcome[]): Record<string, number | null> {
  const latencies = outcomes.map((outcome) => outcome.latency_ms);
  const tokens = outcomes.map((outcome) => outcome.response_tokens).filter((value): value is number => value !== null);
  const annotated = outcomes.reduce((sum, outcome) => sum + outcome.annotated_evidence, 0);
  const annotatedFound = outcomes.reduce((sum, outcome) => sum + outcome.annotated_evidence_found, 0);
  const direct = outcomes.reduce((sum, outcome) => sum + outcome.direct_evidence, 0);
  const directFound = outcomes.reduce((sum, outcome) => sum + outcome.direct_evidence_found, 0);
  const returned = outcomes.reduce((sum, outcome) => sum + outcome.excerpts, 0);
  const overlapping = outcomes.reduce((sum, outcome) => sum + outcome.excerpts_overlapping_annotation, 0);

  return {
    questions: outcomes.length,
    complete: outcomes.filter((outcome) => outcome.status === 'complete').length,
    partial: outcomes.filter((outcome) => outcome.status === 'partial').length,
    rejected: outcomes.filter((outcome) => outcome.status === 'rejected').length,
    failed: outcomes.filter((outcome) => outcome.status === 'error').length,
    empty_selections: outcomes.filter((outcome) => outcome.excerpts === 0).length,
    evidence_recall: annotated === 0 ? null : Number((annotatedFound / annotated).toFixed(4)),
    direct_evidence_recall: direct === 0 ? null : Number((directFound / direct).toFixed(4)),
    annotated_precision: returned === 0 ? null : Number((overlapping / returned).toFixed(4)),
    median_latency_ms: quantile(latencies, 0.5),
    p90_latency_ms: quantile(latencies, 0.9),
    median_response_tokens: quantile(tokens, 0.5),
    max_response_tokens: tokens.length === 0 ? null : Math.max(...tokens),
    provider_attempts: outcomes.reduce((sum, outcome) => sum + outcome.provider_attempts, 0),
    attempts_with_unknown_usage: outcomes.reduce((sum, outcome) => sum + outcome.attempts_with_unknown_usage, 0),
    input_tokens_known: outcomes.reduce((sum, outcome) => sum + outcome.input_tokens_known, 0),
    cache_reused_fragments: outcomes.reduce((sum, outcome) => sum + outcome.cache_reused, 0),
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
  if (options.providerMode === 'live') requireQualifiedLiveSearch();
  const manifest = JSON.parse(readFileSync(options.manifestPath, 'utf8')) as CorpusManifest;
  if (manifest.split !== 'development') {
    throw new Error('this development runner cannot execute held-out data; JG-028/JG-029 require an isolated executor');
  }
  const fixtureRoot = resolve(repositoryRoot, 'benchmarks', 'fixtures', manifest.fixture.id);

  const configuration = options.configuration ?? temporaryConfiguration(fixtureRoot, options);
  const provider = options.providerMode === 'offline' ? new OfflineLexicalProvider() : undefined;
  const engine = createSearchEngine({
    configuration,
    ...(provider === undefined ? {} : { provider }),
    env,
  });

  if (options.cacheState === 'cold') {
    engine.cache.clear();
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
      outcomes.push({
        question_id: question.id, kind: question.kind, status: outcome.status,
        selection_outcome: `error:${outcome.error.code}`, stop_reasons: [outcome.error.code],
        excerpts: 0, response_tokens: measuredTokens, latency_ms: latencyMs,
        annotated_evidence: question.expected_evidence.length, annotated_evidence_found: 0,
        direct_evidence: question.expected_evidence.filter((item) => item.role === 'direct').length,
        direct_evidence_found: 0, excerpts_overlapping_annotation: 0,
        provider_attempts: 0, input_tokens_known: 0, attempts_with_unknown_usage: 0,
        estimated_cost_usd: null, cache_reused: 0, remote_evaluated: 0, scope_fully_scanned: false,
      });
      continue;
    }
    outcomes.push(measureQuestion(question, outcome, latencyMs, measuredTokens));
  }

  const caveats = [
    'annotations are an incomplete, revisable reference: an unannotated excerpt is not proven useless',
    'dollar figures are estimates from a dated rate card, never an invoice',
    'attempts whose usage the provider did not report are counted as unknown, not as zero',
  ];
  if (options.providerMode === 'offline') {
    caveats.unshift('OFFLINE MODE: scores come from a deterministic local scorer; these numbers exercise the runner, they do not measure Jev retrieval quality');
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
      },
      corpus: {
        file: basename(options.manifestPath),
        split: manifest.split,
        fixture: manifest.fixture.id,
        revision: `${manifest.fixture.revision.kind}:${manifest.fixture.revision.value}`,
      },
      caveats,
    },
    questions: outcomes,
    summary: summarize(outcomes),
  };
}

/**
 * A throwaway trusted configuration for a fixture.
 *
 * It lives in a temporary directory, never inside the searched fixture and never
 * inside the project tree: a configuration a repository could edit would not be
 * trusted (specification 5.1).
 */
function temporaryConfiguration(fixtureRoot: string, options: RunOptions): LoadedConfiguration {
  const workspace = mkdtempSync(join(tmpdir(), 'jevgrep-benchmark-'));
  const base = createDefaultConfiguration(fixtureRoot.split('\\').join('/'), 'jev-1.13.0');
  const config = {
    ...base,
    remote_evaluation_enabled: options.providerMode === 'live',
    search: { ...base.search, ...(options.threshold === undefined ? {} : { threshold: options.threshold }) },
  };
  const configPath = join(workspace, `${basename(fixtureRoot)}.config.json`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return loadConfiguration(configPath, { env });
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
    '| question | status | selection | excerpts | direct evidence found | response tokens | latency ms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...run.questions.map((question) => `| ${question.question_id} | ${question.status} | ${question.selection_outcome} `
      + `| ${String(question.excerpts)} | ${String(question.direct_evidence_found)}/${String(question.direct_evidence)} `
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

  for (const manifestPath of manifests) {
    const run = await runManifest({
      manifestPath: resolve(manifestPath),
      providerMode: options.providerMode,
      cacheState: options.cacheState,
    });
    if (options.out === null) {
      stdout.write(`${renderRun(run)}\n`);
    } else {
      mkdirSync(dirname(resolve(options.out)), { recursive: true });
      const stem = resolve(options.out).replace(/\.(json|md)$/, '');
      writeFileSync(`${stem}.json`, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      writeFileSync(`${stem}.md`, renderRun(run), 'utf8');
      stdout.write(`wrote ${stem}.json and ${stem}.md\n`);
    }
  }
}
