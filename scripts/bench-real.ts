import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSearchEngine } from '../src/engine.ts';
import { SearchProfiler } from '../src/profiling.ts';
import { environment, positiveInteger, projectRoot, workspace, writeReport } from './bench/common.ts';
import { assertFrozen, digest, writeFreeze } from './bench/freeze.ts';
import { liveProvider } from './bench/live-provider.ts';
import { loadManifest, mapLimit, type RealSplit } from './bench/real-tasks.ts';
import { loadSnapshots } from './bench/snapshots.ts';
import { groupBy, mean, plannedSummary } from './bench/report.ts';
import { localizationMetrics } from './bench/retrieval.ts';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, split: { type: 'string' }, output: { type: 'string' }, mirrors: { type: 'string' },
  frozen: { type: 'string' }, freeze: { type: 'string' }, jobs: { type: 'string' }, only: { type: 'string' },
  'max-requests': { type: 'string' }, 'max-input-tokens': { type: 'string' }, 'response-tokens': { type: 'string' },
  'validate-only': { type: 'boolean' }, help: { type: 'boolean' },
} });

type Planned = { id: string; category: string; repository: string };
type Summaryrow = Planned & { metrics: ReturnType<typeof localizationMetrics> };

function summarize(rows: readonly Summaryrow[], planned: readonly Planned[]) {
  const pick = (key: 'recallAt1' | 'recallAt5' | 'reciprocalRank' | 'evidenceCoverage' | 'fileRecall' | 'complementaryCoverage', group: readonly Summaryrow[]) =>
    mean(group.flatMap((row) => row.metrics?.[key] == null ? [] : [row.metrics[key]!]));
  const one = (group: readonly Summaryrow[], ids: readonly string[]) => ({
    ...plannedSummary(ids, group), recallAt1: pick('recallAt1', group), recallAt5: pick('recallAt5', group),
    mrr: pick('reciprocalRank', group), evidenceCoverage: pick('evidenceCoverage', group),
    fileRecall: pick('fileRecall', group), complementaryCoverage: pick('complementaryCoverage', group),
  });
  const ids = (entries: readonly Planned[]) => entries.map((entry) => entry.id);
  // Slices take their denominators from the plan, so a query that never ran still counts in its slice.
  const slice = (key: (entry: Planned) => string) => Object.fromEntries([...groupBy(planned, key)].map(([name, entries]) =>
    [name, one(rows.filter((row) => key(row) === name), ids(entries))]));
  return { overall: one(rows, ids(planned)), byCategory: slice((entry) => entry.category), byRepository: slice((entry) => entry.repository) };
}

if (values.help) {
  console.log([
    'npm run bench:real -- --validate-only',
    'npm run bench:real -- --config <trusted-config> --split dev [--jobs 1] [--max-requests 400] [--output benchmark-results/real-dev.json]',
    'npm run bench:real -- --config <trusted-config> --split heldout --freeze benchmark-results/real-heldout.freeze.json',
    'npm run bench:real -- --config <trusted-config> --split heldout --frozen benchmark-results/real-heldout.freeze.json',
  ].join('\n'));
} else {
  const manifest = loadManifest();
  const split = (values.split ?? 'dev') as RealSplit;
  if (split !== 'dev' && split !== 'heldout') throw new Error('--split must be dev or heldout');
  const only = values.only?.split(',');
  const tasks = manifest.tasks.filter((task) => (values['validate-only'] || task.split === split) && (!only || only.includes(task.id)));
  const snapshots = await loadSnapshots(tasks, values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors'));
  const queries = tasks.flatMap((task) => task.queries.map((query) => ({ task, query })));
  if (values['validate-only']) {
    console.log(`Validated ${tasks.length} pinned real tasks and ${queries.length} queries (${manifest.version}); no provider calls.`);
  } else {
    if (values.config === undefined) throw new Error('provide --config for live evaluation, or --validate-only');
    const live = liveProvider(values.config, {
      requests: positiveInteger(values['max-requests'], 400), estimatedInputTokens: positiveInteger(values['max-input-tokens'], 4_000_000),
    });
    const responseTokens = positiveInteger(values['response-tokens'], 4_000);
    if (responseTokens > live.template.config.search.max_response_tokens) throw new Error('response budget exceeds trusted configuration maximum');
    const host = environment();
    const settings = { provider: live.settings, search: live.template.config.search, scanCaps: live.template.config.scan_caps, responseTokens, caps: live.caps, scoreCache: 'disabled' };
    const identity = {
      split, datasetHash: digest(tasks), sourceHash: host.sourceHash, harnessHash: host.harnessHash,
      packageLockHash: host.packageLockHash, settingsHash: digest(settings), model: live.provider.model,
    };
    if (values.freeze !== undefined) {
      console.log(`Frozen ${split} manifest: ${writeFreeze(values.freeze, identity)}`);
    } else {
      const frozen = split === 'heldout' ? assertFrozen(values.frozen, identity) : null;
      const planned = queries.map(({ task, query }) => ({ id: query.id, category: query.category, repository: task.repository }));
      const notRun: string[] = [];
      const rows = (await mapLimit(queries, positiveInteger(values.jobs, 1), async ({ task, query }) => {
        if (live.exhausted()) { notRun.push(query.id); return null; }
        console.error(`Real ${query.id}`);
        const space = workspace(snapshots.get(task.id)!, (base) => live.configure(base));
        const started = performance.now();
        try {
          const profile = new SearchProfiler();
          const result = await createSearchEngine({ configuration: space.loaded, provider: live.provider }).search({
            query: query.query, scope: ['.'], max_context_tokens: responseTokens,
          }, { searchId: query.id, profile });
          const metrics = localizationMetrics(query, result.outcome);
          console.error(`  ${query.id} ${'report' in result.outcome ? result.outcome.status : 'error'} R@5=${metrics?.recallAt5 ?? '-'}`);
          return {
            id: query.id, task: task.id, repository: task.repository, split: task.split, category: query.category, label: query.label,
            latencyMs: performance.now() - started, metrics, responseTokens: result.measuredTokens,
            outcome: result.outcome, profile: profile.snapshot(),
          };
        } finally {
          space.cleanup();
        }
      })).filter((row) => row !== null);
      const current = environment();
      const sourceStable = current.sourceHash === host.sourceHash && current.harnessHash === host.harnessHash && current.packageLockHash === host.packageLockHash;
      const report = {
        schemaVersion: 1, kind: 'real-task-retrieval', createdAt: new Date().toISOString(), environment: host, sourceStable, frozen,
        dataset: { version: manifest.version, source: manifest.source, selection: manifest.selection, split, hash: identity.datasetHash, tasks },
        settings,
        semantics: {
          labels: 'required units are pre-change patch sites (whitespace/import/docstring-only hunks dropped, new-definition placement demoted to complementary); they are not exhaustive relevance',
          recall: 'fraction of required units fully covered in the first k excerpts, over complete searches',
          fileRecall: 'fraction of edited files with at least one returned excerpt',
          complementaryCoverage: 'fraction of complementary units (tests, placement, audited context) overlapped by any excerpt; never counted as a miss',
          categories: 'change-localization uses the issue text; code-understanding asks for the function whose docstring is quoted',
          limitations: 'small public SWE-bench sample, issue text may name symbols; held-out means repository-held-out for tuning, not blind',
        },
        usage: live.usage, summary: { ...summarize(rows, planned), notRun: notRun.length }, notRun, rows,
      };
      const path = writeReport(values.output ?? `benchmark-results/real-${split}.json`, report);
      console.log(JSON.stringify(report.summary, null, 2));
      console.log(`Report: ${path}`);
      if (!sourceStable || notRun.length > 0 || report.summary.overall.incomplete > 0) process.exitCode = 1;
    }
  }
}
