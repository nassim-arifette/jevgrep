import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import { DEFAULT_WINDOW_LIMITS, syntaxLanguageOf, type PreparedFragment, type SyntaxLanguage } from '../src/source/chunker.ts';
import { createSnapshot } from '../src/source/snapshot.ts';
import { CHUNKING_ARMS, chunkingArm } from './bench/chunking-arms.ts';
import { projectRoot, writeReport } from './bench/common.ts';
import { javascriptManifestPath, loadManifest, systemsManifestPath } from './bench/real-tasks.ts';
import { mean } from './bench/report.ts';
import { loadSnapshots } from './bench/snapshots.ts';

/**
 * Offline structural comparison of the chunking arms: the E1 arms on the pinned JS/TS
 * tasks, or with `--go-rust` line windows against Tree-sitter on the Go/Rust tasks.
 * No provider call: it measures fragment shape and how required evidence lands in
 * fragments, which explains (but never replaces) the live retrieval comparison.
 */
const { values } = parseArgs({ options: { mirrors: { type: 'string' }, output: { type: 'string' }, 'go-rust': { type: 'boolean' }, help: { type: 'boolean' } } });

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

if (values.help) {
  console.log('npm run bench:chunking -- [--go-rust] [--mirrors benchmark-results/mirrors] [--output benchmark-results/chunking.json]');
} else {
  const goRust = values['go-rust'] === true;
  const manifest = loadManifest(goRust ? systemsManifestPath : javascriptManifestPath, {});
  const languages: readonly (SyntaxLanguage | null)[] = goRust ? ['go', 'rust'] : ['javascript'];
  const measured = (path: string): boolean => languages.includes(syntaxLanguageOf(path));
  const armsUnderTest = goRust ? (['go-rust-line-windows', 'recursive'] as const) : CHUNKING_ARMS.filter((arm) => arm !== 'go-rust-line-windows');
  const snapshots = await loadSnapshots(manifest.tasks, values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors'));
  const arms = Object.fromEntries(armsUnderTest.map((arm) => {
    const chunker = chunkingArm(arm);
    const seen = new Map<string, readonly PreparedFragment[]>();
    let parseFallbacks = 0;
    let milliseconds = 0;
    const fragmentsOf = (repository: string, path: string, text: string): readonly PreparedFragment[] => {
      const key = `${repository}\0${path}\0${text}`;
      const cached = seen.get(key);
      if (cached !== undefined) return cached;
      const bytes = Buffer.from(text, 'utf8');
      const snapshot = createSnapshot(path, path, bytes, countReferenceTokens);
      const started = performance.now();
      const result = chunker.chunk(snapshot, DEFAULT_WINDOW_LIMITS);
      milliseconds += performance.now() - started;
      const fragments = result.kind === 'fragments' ? result.fragments : [];
      if (result.kind === 'fragments' && result.fallback !== null) parseFallbacks += 1;
      seen.set(key, fragments);
      return fragments;
    };
    const units: { contained: boolean; tokens: number | null; labeled: boolean; fragments: number }[] = [];
    for (const task of manifest.tasks) {
      const files = snapshots.get(task.id)!;
      for (const [path, text] of Object.entries(files)) {
        if (measured(path)) fragmentsOf(task.repository, path, text);
      }
      for (const query of task.queries) {
        for (const unit of query.evidence) {
          if (!measured(unit.path)) continue;
          const fragments = fragmentsOf(task.repository, unit.path, files[unit.path]!);
          const overlapping = fragments.filter((fragment) => fragment.startLine <= unit.endLine && fragment.endLine >= unit.startLine);
          const whole = overlapping.find((fragment) => fragment.startLine <= unit.startLine && fragment.endLine >= unit.endLine);
          units.push({
            contained: whole !== undefined, tokens: whole?.tokenCount ?? null,
            labeled: overlapping.length > 0 && overlapping.every((fragment) => fragment.label != null), fragments: overlapping.length,
          });
        }
      }
    }
    const all = [...seen.values()].flat();
    const tokens = all.map((fragment) => fragment.tokenCount).sort((a, b) => a - b);
    return [arm, {
      files: seen.size, fragments: all.length, parseFallbacks, chunkingMs: Math.round(milliseconds),
      fragmentTokens: { mean: mean(tokens), p50: percentile(tokens, 0.5), p95: percentile(tokens, 0.95), max: tokens.at(-1) ?? null },
      labeledFragments: mean(all.map((fragment) => fragment.label == null ? 0 : 1)),
      smallFragments: mean(all.map((fragment) => fragment.endLine - fragment.startLine + 1 <= 3 ? 1 : 0)),
      evidence: {
        units: units.length, containedInOneFragment: mean(units.map((unit) => unit.contained ? 1 : 0)),
        containingFragmentTokens: mean(units.flatMap((unit) => unit.tokens === null ? [] : [unit.tokens])),
        labeled: mean(units.map((unit) => unit.labeled ? 1 : 0)),
      },
    }];
  }));
  const report = { schemaVersion: 1, kind: 'chunking-structure', createdAt: new Date().toISOString(), dataset: manifest.version, limits: DEFAULT_WINDOW_LIMITS, arms };
  console.table(Object.fromEntries(Object.entries(arms).map(([arm, row]) => [arm, {
    files: row.files, fragments: row.fragments, fallbacks: row.parseFallbacks, ms: row.chunkingMs,
    meanTok: Math.round(row.fragmentTokens.mean ?? 0), p95Tok: row.fragmentTokens.p95, labeled: row.labeledFragments?.toFixed(3),
    small: row.smallFragments?.toFixed(3), evContained: row.evidence.containedInOneFragment?.toFixed(3),
    evFragTok: Math.round(row.evidence.containingFragmentTokens ?? 0), evLabeled: row.evidence.labeled?.toFixed(3),
  }])));
  console.log(`-> ${writeReport(values.output ?? 'benchmark-results/chunking.json', report)}`);
}
