/**
 * Multiquestion benchmark (roadmap section 13): several questions over one scope, as
 * separate CLI-like searches (a fresh engine per question, so only the persisted
 * preparation cache is shared) against one `searchMany` call sharing preparation.
 *
 * The provider answers instantly and locally, so the measurement isolates local work
 * and costs nothing; remote evaluations are counted, not sent. Queries are unique per
 * repetition so score-cache reuse cannot favour either arm.
 *
 *   node scripts/bench-multiquestion.ts --corpus cobra=/path/to/cobra --questions 3 \
 *     --repeats 5 --output benchmark-results/multiquestion.json
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfiguration } from '../src/config.ts';
import { createDefaultConfiguration } from '../src/contracts.ts';
import { createSearchEngine } from '../src/engine.ts';
import type { ProviderClient } from '../src/evaluation/contracts.ts';
import { environment, positiveInteger, writeReport } from './bench/common.ts';

const QUESTIONS = [
  'Where are command-line flags parsed?',
  'How are errors reported to the user?',
  'Where is help text generated?',
  'Which code reads configuration files?',
  'How are tests for argument validation organised?',
];

const provider: ProviderClient & { attempts: number; questions: number } = {
  model: 'jev-1.13.0', attempts: 0, questions: 0,
  async evaluateBatch(batch) {
    this.attempts += 1;
    this.questions += batch.items.length;
    return { scores: new Map(batch.items.map((item) => [item.id, 0.3])), invalid: [],
      usage: { inputTokens: 1, outputTokens: 0 }, requestedModel: this.model, returnedModel: this.model,
      transmittedBytes: 0, requestId: null };
  },
};

function profileFor(corpus: string) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jevgrep-mq-')));
  const config = { ...createDefaultConfiguration(resolve(corpus).replaceAll('\\', '/'), 'jev-1.13.0'), remote_evaluation_enabled: true };
  const configPath = join(root, 'jevgrep.config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const env = { JEVGREP_CACHE_HOME: join(root, 'cache'), JEVGREP_CONFIG_HOME: join(root, 'configuration') };
  mkdirSync(env.JEVGREP_CACHE_HOME);
  return { root, loaded: loadConfiguration(configPath, { env }) };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const { values } = parseArgs({ options: {
  corpus: { type: 'string', multiple: true }, questions: { type: 'string' }, repeats: { type: 'string' },
  output: { type: 'string' },
} });
const questionCount = Math.min(positiveInteger(values.questions, 3), QUESTIONS.length);
const repeats = positiveInteger(values.repeats, 5);
const results = [];
for (const entry of values.corpus ?? []) {
  const [name, path] = entry.split('=') as [string, string];
  const profile = profileFor(path);
  try {
    const questions = (rep: number, arm: string) => QUESTIONS.slice(0, questionCount).map((q) => ({ query: `${q} (${arm} ${String(rep)})` }));
    // Warm-up: populate the persisted preparation cache as a previous CLI run would have.
    await createSearchEngine({ configuration: profile.loaded, provider }).search({ query: 'warm-up' });
    const arms: Record<string, number[]> = { separate: [], shared: [] };
    const attempts: Record<string, number[]> = { separate: [], shared: [] };
    for (let rep = 0; rep < repeats; rep += 1) {
      for (const arm of rep % 2 === 0 ? ['separate', 'shared'] : ['shared', 'separate']) {
        const before = provider.attempts;
        const start = performance.now();
        if (arm === 'separate') {
          for (const request of questions(rep, arm)) {
            await createSearchEngine({ configuration: profile.loaded, provider }).search(request);
          }
        } else {
          await createSearchEngine({ configuration: profile.loaded, provider }).searchMany(questions(rep, arm));
        }
        arms[arm]!.push(performance.now() - start);
        attempts[arm]!.push(provider.attempts - before);
      }
    }
    const row = {
      corpus: name, questions: questionCount, repeats,
      separate_ms_median: Math.round(median(arms['separate']!)), shared_ms_median: Math.round(median(arms['shared']!)),
      saving: Number((1 - median(arms['shared']!) / median(arms['separate']!)).toFixed(3)),
      provider_attempts_per_call: { separate: median(attempts['separate']!), shared: median(attempts['shared']!) },
    };
    console.log(JSON.stringify(row));
    results.push(row);
  } finally { rmSync(profile.root, { recursive: true, force: true }); }
}
if (values.output !== undefined) writeReport(values.output, { environment: environment(), results });
