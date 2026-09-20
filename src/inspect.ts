/**
 * Local scope inspection (JG-023 `inspect`, specification section 2.1).
 *
 * `inspect` answers the operator's question before any disclosure: what would this
 * scope send, how much of it is there, and what was excluded and why. It reads the
 * repository through the same authorized root and the same preparation code as a
 * search, and it contacts no provider and needs no credential.
 *
 * Quantities that depend on a search question — how many fragments a cache would
 * already hold, what the provider would actually bill — stay explicitly unknown
 * rather than being estimated into a comforting number.
 */
import { exclusionCounts, prepareScope } from './source/prepare.ts';
import type { LoadedConfiguration } from './config.ts';
import { buildBatches } from './engine.ts';
import type { EvaluationBatch } from './evaluation/jev.ts';
import { batchLimits } from './evaluation/policy.ts';
import { configuredAdapter, serializeConfiguredBatch } from './evaluation/provider.ts';
import { countReferenceTokens } from './response/token-counter.ts';

export type InspectionReport = {
  readonly repository_root: string;
  readonly scope: readonly string[];
  readonly inventory_complete: boolean;
  readonly files: {
    readonly discovered: number;
    readonly eligible: number;
    readonly unreadable: number;
    readonly excluded_by_reason: Readonly<Record<string, number>>;
    /** Directories never entered: their descendants are unknown, not counted as zero. */
    readonly excluded_directories_by_reason: Readonly<Record<string, number>>;
  };
  readonly fragments: {
    readonly total: number | null;
    readonly by_strategy: Readonly<Record<string, number>>;
    readonly parse_fallbacks: number;
    readonly reference_tokens: number;
    readonly source_bytes: number;
    readonly largest_tokens: number;
  };
  readonly estimates: {
    /** First-attempt plan for a question of the given length; an estimate, never a bill. */
    readonly requests: number;
    readonly input_tokens: number;
    readonly cost_usd: number | null;
    readonly cost_note: string;
    /** Unknown without a question: a cache hit depends on the exact query. */
    readonly cache_hits: null;
    readonly provider_context_limit_tokens: number;
  };
  readonly remote_evaluation_enabled: boolean;
  readonly notes: readonly string[];
};

export type InspectOptions = {
  readonly scope: readonly string[];
  /** Length-representative question used only to size the first-attempt estimate. */
  readonly sampleQuery?: string;
};

const SAMPLE_QUERY = 'Which code handles this behaviour?';

/** Inventory, prepare and size a scope without contacting the provider. */
export function inspectScope(configuration: LoadedConfiguration, options: InspectOptions): InspectionReport {
  const { config } = configuration;
  const root = configuration.sourceRoot;
  const prepared = prepareScope(root, options.scope, {
    inventory: {
      respectGitignore: config.source.respect_gitignore,
      maxFileBytes: config.source.max_file_bytes,
      extraDenyGlobs: config.source.extra_deny_globs,
    },
    limits: {
      preparedSourceBytes: config.scan_caps.prepared_source_bytes,
      candidateFiles: config.scan_caps.candidate_files,
      fragments: config.scan_caps.fragments,
    },
  });

  const byStrategy: Record<string, number> = {};
  let referenceTokens = 0;
  let sourceBytes = 0;
  let largest = 0;
  for (const fragment of prepared.fragments) {
    byStrategy[fragment.classification] = (byStrategy[fragment.classification] ?? 0) + 1;
    referenceTokens += fragment.tokenCount;
    sourceBytes += fragment.byteCount;
    largest = Math.max(largest, fragment.tokenCount);
  }

  const excludedDirectories: Record<string, number> = {};
  for (const directory of prepared.inventory.excludedDirectories) {
    excludedDirectories[directory.reason] = (excludedDirectories[directory.reason] ?? 0) + 1;
  }

  const query = options.sampleQuery ?? SAMPLE_QUERY;
  const adapter = configuredAdapter(config);
  const limits = batchLimits(adapter);
  const serialize = (batch: EvaluationBatch): string => serializeConfiguredBatch(config, batch);
  const batches = buildBatches(prepared.fragments, query, { limits, serialize });
  const estimatedInputTokens = batches.reduce((total, batch) => total + countReferenceTokens(serialize(batch)), 0);
  const pricing = config.provider.pricing;
  const estimatedCost = pricing == null
    ? null
    : Number(((estimatedInputTokens * pricing.input_usd_per_million_tokens) / 1_000_000).toFixed(6));

  const notes: string[] = [];
  if (!prepared.inventory.complete) {
    notes.push('the inventory did not finish: counts are lower bounds and no full-coverage claim is possible');
  }
  if (!prepared.complete && prepared.inventory.complete) {
    notes.push('preparation stopped on an enabled preparation cap: the fragment total is a lower bound');
  }
  if (prepared.unreadable > 0) {
    notes.push(`${String(prepared.unreadable)} eligible file(s) could not be read`);
  }
  if (prepared.parseFallbacks > 0) {
    notes.push(`${String(prepared.parseFallbacks)} JS/TS file(s) fell back to line windows after a lexical parse failure`);
  }
  if (!config.remote_evaluation_enabled) {
    notes.push('remote evaluation is disabled: a search would be refused before any excerpt leaves this machine');
  }
  notes.push('token and cost figures are local estimates under the pinned reference counter, not provider billing');
  notes.push(`batch target: ${String(limits.totalTokens * limits.headroomRatio)} reference tokens, at most ${String(limits.maxItems)} questions and ${String(limits.maxRequestBytes)} wire bytes`);
  if (adapter === 'openrouter') {
    notes.push('OpenRouter advertises a 32k context; its use as an aggregate batch ceiling is a conservative local policy');
  }
  if (adapter === 'vercel-ai-gateway') {
    notes.push('Gateway advertises a 32k context; its use as an aggregate batch ceiling is a conservative local policy');
  }

  return {
    repository_root: configuration.repositoryRoot,
    scope: [...options.scope],
    inventory_complete: prepared.inventory.complete && prepared.complete,
    files: {
      discovered: prepared.inventory.discovered,
      eligible: prepared.files.length,
      unreadable: prepared.unreadable,
      excluded_by_reason: exclusionCounts(prepared),
      excluded_directories_by_reason: excludedDirectories,
    },
    fragments: {
      total: prepared.complete && prepared.unreadable === 0 ? prepared.fragments.length : null,
      by_strategy: byStrategy,
      parse_fallbacks: prepared.parseFallbacks,
      reference_tokens: referenceTokens,
      source_bytes: sourceBytes,
      largest_tokens: largest,
    },
    estimates: {
      requests: batches.length,
      input_tokens: estimatedInputTokens,
      cost_usd: estimatedCost,
      cost_note: pricing == null
        ? 'no dated pricing record is configured, so no USD estimate is produced'
        : `estimated with the ${pricing.verified_at} rate card; an estimate, not an invoice`,
      cache_hits: null,
      provider_context_limit_tokens: limits.totalTokens,
    },
    remote_evaluation_enabled: config.remote_evaluation_enabled,
    notes,
  };
}

/** Human rendering; the JSON form is the report object itself. */
export function renderInspection(report: InspectionReport): string[] {
  const excluded = Object.entries(report.files.excluded_by_reason)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([reason, count]) => `    ${reason}: ${String(count)}`);
  const directories = Object.entries(report.files.excluded_directories_by_reason)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([reason, count]) => `    ${reason}: ${String(count)} directory/directories not entered (descendants unknown)`);
  const strategies = Object.entries(report.fragments.by_strategy)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([strategy, count]) => `${strategy}=${String(count)}`)
    .join(' ');

  return [
    `repository root    ${report.repository_root}`,
    `scope              ${report.scope.join(', ')}`,
    `inventory          ${report.inventory_complete ? 'complete' : 'incomplete (counts are lower bounds)'}`,
    `files              ${String(report.files.eligible)} eligible of ${String(report.files.discovered)} discovered, ${String(report.files.unreadable)} unreadable`,
    ...(excluded.length === 0 ? ['  excluded         none'] : ['  excluded by reason:', ...excluded]),
    ...(directories.length === 0 ? [] : ['  excluded directories:', ...directories]),
    `fragments          ${report.fragments.total === null ? 'unknown total (preparation incomplete)' : String(report.fragments.total)} ${strategies}`,
    `                   ${String(report.fragments.reference_tokens)} reference tokens, ${String(report.fragments.source_bytes)} source bytes, largest ${String(report.fragments.largest_tokens)} tokens`,
    `                   parse fallbacks: ${String(report.fragments.parse_fallbacks)}`,
    `estimated scan     ${String(report.estimates.requests)} provider request(s), ~${String(report.estimates.input_tokens)} input tokens`,
    `estimated cost     ${report.estimates.cost_usd === null ? 'unknown' : `$${String(report.estimates.cost_usd)}`} (${report.estimates.cost_note})`,
    'cache hits         unknown without a search question',
    `remote evaluation  ${report.remote_evaluation_enabled ? 'enabled' : 'disabled'}`,
    ...report.notes.map((note) => `note               ${note}`),
  ];
}
