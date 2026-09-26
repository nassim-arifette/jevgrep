import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { positiveInteger, projectRoot, writeReport } from './bench/common.ts';
import {
  buildTask, ensureMirror, exportSnapshot, manifestPath, mapLimit, orderInstances, realRepositories,
  type RealManifest, type RealRepository, type RealTask, type SweInstance,
} from './bench/real-tasks.ts';

const { values } = parseArgs({ options: {
  instances: { type: 'string' }, mirrors: { type: 'string' }, output: { type: 'string' }, revision: { type: 'string' },
  'per-repo': { type: 'string' }, seed: { type: 'string' }, help: { type: 'boolean' },
} });

if (values.help || values.instances === undefined) {
  console.log('npm run bench:real:import -- --instances swe-bench-test.jsonl [--revision <dataset-commit>] [--per-repo psf/requests=8,pallets/flask=4] [--mirrors benchmark-results/mirrors] [--output benchmarks/real-tasks/swe-bench-sample-1.json]');
} else {
  const perRepository = Object.fromEntries((values['per-repo'] ?? 'psf/requests=8,pallets/flask=4').split(',').map((entry) => {
    const [name, count] = entry.split('=');
    if (!(name! in realRepositories)) throw new Error(`unsupported repository ${name}`);
    return [name!, positiveInteger(count, 1)];
  })) as Record<RealRepository, number>;
  const seed = values.seed ?? 'jevgrep-real-1';
  const selection = { seed, perRepository, maxEditFiles: 3, maxQueryBytes: 7_000 };
  const instances = readFileSync(values.instances, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as SweInstance);
  const mirrorRoot = values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors');
  const repositories = Object.keys(perRepository) as RealRepository[];
  const mirrors = new Map(await Promise.all(repositories.map(async (name) => [name, await ensureMirror(mirrorRoot, name)] as const)));
  const tasks: RealTask[] = [];
  for (const repository of repositories) {
    const candidates = orderInstances(instances.filter((instance) => instance.repo === repository), seed);
    const built = await mapLimit(candidates, availableParallelism(), async (instance) =>
      buildTask(instance, await exportSnapshot(mirrors.get(repository)!, repository, instance.base_commit), selection.maxEditFiles, selection.maxQueryBytes));
    const chosen = built.filter((task) => task !== null).slice(0, perRepository[repository]);
    if (chosen.length < perRepository[repository]) throw new Error(`${repository}: only ${chosen.length} eligible tasks`);
    tasks.push(...chosen);
  }
  const manifest: RealManifest = {
    version: 'swe-bench-sample-1',
    source: { dataset: 'princeton-nlp/SWE-bench', split: 'test', license: 'MIT (dataset); issue text and code from the upstream repositories', revision: values.revision ?? null },
    selection, tasks,
  };
  const path = writeReport(values.output ?? manifestPath, manifest);
  console.log(`${tasks.length} tasks, ${tasks.reduce((sum, task) => sum + task.queries.length, 0)} queries -> ${path}`);
}
