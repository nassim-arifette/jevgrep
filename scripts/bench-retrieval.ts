import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createSearchEngine } from '../src/engine.ts';
import { SearchProfiler } from '../src/profiling.ts';
import { environment, positiveInteger, workspace, writeReport } from './bench/common.ts';
import { datasetVersion, fixtureHashes, questions, validateDataset } from './bench/dataset.ts';
import { liveProvider } from './bench/live-provider.ts';
import { retrievalMetrics, summarizeRetrieval } from './bench/retrieval.ts';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, output: { type: 'string' }, 'max-requests': { type: 'string' },
  'max-input-tokens': { type: 'string' }, 'response-tokens': { type: 'string' },
  'validate-only': { type: 'boolean' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('npm run bench:retrieval -- --validate-only\nnpm run bench:retrieval -- --config <trusted-config> [--max-requests 60] [--max-input-tokens 200000] [--response-tokens 4000] [--output benchmark-results/retrieval.json]');
} else {
  const repositories = validateDataset();
  if (values['validate-only']) {
    console.log(`Validated ${questions.length} questions on ${repositories.size} pinned synthetic repositories (${datasetVersion}); no provider calls.`);
  } else {
    if (values.config === undefined) throw new Error('provide --config for live evaluation, or --validate-only for offline annotation checks');
    const live = liveProvider(values.config, {
      requests: positiveInteger(values['max-requests'], 60),
      estimatedInputTokens: positiveInteger(values['max-input-tokens'], 200_000),
    });
    const { template, provider, usage, caps } = live;
    const responseTokens = positiveInteger(values['response-tokens'], 4_000);
    if (responseTokens > template.config.search.max_response_tokens) throw new Error('response budget exceeds trusted configuration maximum');
    const host = environment();
    const rows = [];
    const notRun: string[] = [];
    for (const question of questions) {
      if (live.exhausted()) {
        notRun.push(question.id);
        continue;
      }
      console.error(`Retrieval ${question.id} (${question.repository})`);
      const space = workspace(repositories.get(question.repository)!, (base) => live.configure(base));
      try {
        const profile = new SearchProfiler();
        const result = await createSearchEngine({ configuration: space.loaded, provider }).search({
          query: question.query, scope: ['.'], max_context_tokens: responseTokens,
        }, { searchId: question.id, profile });
        rows.push({
          id: question.id, repository: question.repository, kind: question.kind,
          metrics: retrievalMetrics(question, result.outcome), responseTokens: result.measuredTokens,
          outcome: result.outcome, profile: profile.snapshot(),
        });
      } finally {
        space.cleanup();
      }
    }
    const metrics = summarizeRetrieval(rows.map((row) => row.metrics));
    const current = environment();
    const sourceStable = current.sourceHash === host.sourceHash && current.harnessHash === host.harnessHash && current.packageLockHash === host.packageLockHash;
    const report = {
      schemaVersion: 1, kind: 'live-retrieval', createdAt: new Date().toISOString(), environment: host, sourceStable,
      dataset: { version: datasetVersion, fixtureHashes, questionsHash: createHash('sha256').update(JSON.stringify(questions)).digest('hex'), questions },
      settings: {
        provider: live.settings,
        search: template.config.search, scanCaps: template.config.scan_caps,
        responseTokens, caps, scoreCache: 'disabled', source: 'fixed fixture defaults; only copied synthetic fixtures are searched',
      },
      semantics: {
        recall: 'fraction of required evidence units fully covered in the first k returned excerpts, macro-averaged over complete positive searches',
        mrr: 'reciprocal rank of the first returned excerpt fully covering at least one required evidence unit',
        negatives: 'correct only for a fully scanned, complete result with no excerpt; errors and partial scans are ineligible',
        limitations: 'development pilot on small synthetic fixtures, not held-out, not an agent end-to-end or multilingual quality benchmark',
        caps: 'input tokens are conservative local reservations, not a guaranteed billing ceiling',
      },
      usage, summary: { ...metrics, planned: questions.length, notRun: notRun.length }, notRun, rows,
    };
    const path = writeReport(values.output ?? 'benchmark-results/retrieval.json', report);
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`Report: ${path}`);
    if (!sourceStable || notRun.length > 0 || metrics.incomplete > 0) process.exitCode = 1;
  }
}
