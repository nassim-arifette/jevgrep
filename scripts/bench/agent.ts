import type { Evidence } from './dataset.ts';
import { groupBy, latencySummary, mean, quantile } from './report.ts';

/** One agent attempt at a real task under one arm; errors stay in the data as `status`. */
export type Arm = 'baseline' | 'jevgrep';
export type AgentRun = {
  readonly task: string;
  readonly repository: string;
  readonly arm: Arm;
  readonly repeat: number;
  readonly status: 'submitted' | 'no_submission' | 'error';
  readonly error: string | null;
  readonly success: boolean | null;
  readonly fileHit: boolean | null;
  readonly toolCalls: number;
  readonly turns: number;
  readonly filesOpened: number;
  readonly fileRereads: number;
  readonly jevCalls: number;
  readonly agentInputTokens: number | null;
  readonly agentOutputTokens: number | null;
  readonly agentCostUsd: number | null;
  readonly jevInputTokens: number | null;
  readonly jevCostUsd: number | null;
  readonly totalCostUsd: number | null;
  readonly latencyMs: number;
  readonly initializationMs: number | null;
};

/** Submitted ranges succeed when one overlaps a required unit, allowing `slack` lines. */
export function scoreSubmission(submitted: readonly Evidence[], required: readonly Evidence[], slack = 3) {
  const hit = (unit: Evidence) => submitted.some((range) => range.path === unit.path
    && range.startLine - slack <= unit.endLine && range.endLine + slack >= unit.startLine);
  return { success: required.some(hit), fileHit: required.some((unit) => submitted.some((range) => range.path === unit.path)) };
}

/** Deterministic PRNG for reproducible bootstrap intervals. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Intervals are withheld below this many complete pairs. */
export const minimumIntervalPairs = 8;

/**
 * Percentile bootstrap of the mean paired difference, resampling tasks (clusters)
 * so that repeats of one task are not treated as independent evidence.
 */
export function bootstrapMeanDifference(clusters: readonly (readonly number[])[], iterations = 4000, seed = 1) {
  const pairs = clusters.flat();
  const estimate = mean(pairs);
  if (pairs.length < minimumIntervalPairs || clusters.length < 3) {
    return { n: pairs.length, clusters: clusters.length, mean: estimate, low: null, high: null, note: `insufficient pairs for an interval (${pairs.length} pairs, ${clusters.length} tasks)` };
  }
  const random = mulberry32(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const drawn: number[] = [];
    for (let index = 0; index < clusters.length; index += 1) drawn.push(...clusters[Math.floor(random() * clusters.length)]!);
    samples.push(mean(drawn)!);
  }
  return { n: pairs.length, clusters: clusters.length, mean: estimate, low: quantile(samples, 0.025), high: quantile(samples, 0.975), note: null };
}

type Numeric = 'toolCalls' | 'filesOpened' | 'fileRereads' | 'agentInputTokens' | 'agentOutputTokens' | 'totalCostUsd' | 'latencyMs';
const numericKeys: readonly Numeric[] = ['toolCalls', 'filesOpened', 'fileRereads', 'agentInputTokens', 'agentOutputTokens', 'totalCostUsd', 'latencyMs'];

function armSummary(runs: readonly AgentRun[]) {
  const complete = runs.filter((run) => run.status !== 'error');
  const values = (key: Numeric) => complete.flatMap((run) => run[key] === null ? [] : [run[key]!]);
  return {
    runs: runs.length, complete: complete.length, errors: runs.length - complete.length,
    successRate: mean(complete.map((run) => Number(run.success === true))),
    fileHitRate: mean(complete.map((run) => Number(run.fileHit === true))),
    unknownCost: complete.filter((run) => run.totalCostUsd === null).length,
    ...Object.fromEntries(numericKeys.map((key) => [key, { mean: mean(values(key)), ...latencySummary(values(key)) }])),
    jevInputTokens: latencySummary(complete.flatMap((run) => run.jevInputTokens === null ? [] : [run.jevInputTokens])),
    initializationMs: latencySummary(complete.flatMap((run) => run.initializationMs === null ? [] : [run.initializationMs])),
  };
}

/** Paired comparison: only (task, repeat) pairs where both arms completed contribute to deltas. */
export function analyzePairedRuns(runs: readonly AgentRun[], seed = 1) {
  const analyze = (group: readonly AgentRun[]) => {
    const key = (run: AgentRun) => `${run.task}#${run.repeat}`;
    const baseline = new Map(group.filter((run) => run.arm === 'baseline').map((run) => [key(run), run]));
    const pairs = group.filter((run) => run.arm === 'jevgrep').flatMap((run) => {
      const other = baseline.get(key(run));
      return other && other.status !== 'error' && run.status !== 'error' ? [[other, run] as const] : [];
    });
    const delta = (value: (run: AgentRun) => number | null) => {
      const byTask = groupBy(pairs.filter(([a, b]) => value(a) !== null && value(b) !== null), ([a]) => a.task);
      return bootstrapMeanDifference([...byTask.values()].map((items) => items.map(([a, b]) => value(b)! - value(a)!)), 4000, seed);
    };
    return {
      baseline: armSummary(group.filter((run) => run.arm === 'baseline')),
      jevgrep: armSummary(group.filter((run) => run.arm === 'jevgrep')),
      pairs: pairs.length,
      wins: pairs.filter(([a, b]) => b.success === true && a.success !== true).length,
      losses: pairs.filter(([a, b]) => a.success === true && b.success !== true).length,
      delta: {
        success: delta((run) => Number(run.success === true)),
        ...Object.fromEntries(numericKeys.map((name) => [name, delta((run) => run[name])])),
      },
    };
  };
  return {
    overall: analyze(runs),
    byRepository: Object.fromEntries([...groupBy(runs, (run) => run.repository)].map(([name, group]) => [name, analyze(group)])),
    semantics: {
      delta: 'mean of (jevgrep - baseline) over (task, repeat) pairs where both arms completed; 95% percentile bootstrap resampling tasks',
      p95: `reported only with at least 20 observations`,
      success: 'a submitted range overlaps a required patch unit within 3 lines',
    },
  };
}
