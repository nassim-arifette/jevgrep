import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import { DEFAULT_CHUNKER, DEFAULT_WINDOW_LIMITS, SYNTAX_CHUNKER_VERSIONS, LINE_WINDOW_CHUNKER_VERSION } from '../src/source/chunker.ts';
import { findCredentialPattern } from '../src/source/prepare.ts';
import { SnapshotError, createSnapshot } from '../src/source/snapshot.ts';
import { environment, projectRoot, writeReport } from './bench/common.ts';
import {
  LANGUAGE_CORPUS, LANGUAGE_GROUPS, emptyCounters, ensureCorpusMirror, exportCorpus, gatesFor, languageGroupOf, measureFile, summarize,
  type GateResult, type GroupCounters, type GroupSummary,
} from './bench/languages.ts';

/**
 * `npm run bench:languages`: offline structural benchmark per language group (language
 * search spec 9.1). No provider call. `--check` fails when a gate is missed.
 */
const { values } = parseArgs({
  options: {
    mirrors: { type: 'string' }, output: { type: 'string' }, languages: { type: 'string' }, repositories: { type: 'string' },
    check: { type: 'boolean' }, baseline: { type: 'string' }, help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log([
    'npm run bench:languages -- [--languages go,rust] [--repositories caddyserver/caddy] [--mirrors benchmark-results/mirrors]',
    '                           [--output benchmark-results/languages.json] [--check] [--baseline benchmarks/baselines/<report>.json]',
    '',
    '--check     exit 1 when a gate of spec 9.1 is missed: every profiled group, or every group named by --languages',
    '--baseline  report whose mid-block shares bound the groups left on line windows (half of the baseline value)',
  ].join('\n'));
} else {
  const wantedLanguages = values.languages?.split(',').filter(Boolean);
  const wantedRepositories = values.repositories?.split(',').filter(Boolean);
  for (const id of wantedLanguages ?? []) {
    if (!LANGUAGE_GROUPS.some((group) => group.id === id)) throw new Error(`unknown language group ${id}`);
  }
  for (const name of wantedRepositories ?? []) {
    if (!LANGUAGE_CORPUS.some((repository) => repository.name === name)) throw new Error(`unknown corpus repository ${name}`);
  }
  const corpus = LANGUAGE_CORPUS.filter((repository) => wantedRepositories === undefined || wantedRepositories.includes(repository.name));
  const groups = LANGUAGE_GROUPS.filter((group) => wantedLanguages === undefined || wantedLanguages.includes(group.id));
  const mirrorRoot = values.mirrors ?? join(projectRoot, 'benchmark-results/mirrors');
  const counters = new Map<string, GroupCounters>(groups.map((group) => [group.id, emptyCounters()]));
  const excluded: Record<string, number> = {};
  const perRepository: Record<string, { commit: string; files: number }> = {};

  // Grammars compile on first use; warm every chunker so timings measure chunking only.
  for (const group of groups) {
    DEFAULT_CHUNKER.chunk(createSnapshot(`warm${group.extensions[0]!}`, 'warm', Buffer.from('x\n'), countReferenceTokens), DEFAULT_WINDOW_LIMITS);
  }
  const mirrors = await Promise.all(corpus.map((repository) => ensureCorpusMirror(mirrorRoot, repository)));
  for (const [index, repository] of corpus.entries()) {
    const files = await exportCorpus(mirrors[index]!, repository);
    let measured = 0;
    for (const { path, bytes } of files) {
      const group = languageGroupOf(path)!;
      const row = counters.get(group.id);
      if (row === undefined) continue;
      // The preparation stage's content checks, in its order: encoding, blank content, credentials.
      let snapshot;
      try { snapshot = createSnapshot(path, path, bytes, countReferenceTokens); } catch (cause) {
        if (!(cause instanceof SnapshotError)) throw cause;
        excluded[cause.refusal] = (excluded[cause.refusal] ?? 0) + 1;
        continue;
      }
      const reason = snapshot.isBlank() ? 'blank' : findCredentialPattern(snapshot.text) !== null ? 'credential_pattern' : null;
      if (reason !== null) { excluded[reason] = (excluded[reason] ?? 0) + 1; continue; }
      const started = performance.now();
      const result = DEFAULT_CHUNKER.chunk(snapshot, DEFAULT_WINDOW_LIMITS);
      if (result.kind !== 'fragments') { excluded[result.reason] = (excluded[result.reason] ?? 0) + 1; continue; }
      measureFile(group, snapshot, result, performance.now() - started, row);
      measured += 1;
    }
    perRepository[repository.name] = { commit: repository.commit, files: measured };
  }

  const rows: Record<string, GroupSummary> = Object.fromEntries([...counters].map(([id, row]) => [id, summarize(row)]));
  const baseline = values.baseline === undefined ? undefined
    : (JSON.parse(readFileSync(values.baseline, 'utf8')) as { groups: Record<string, GroupSummary> }).groups;
  const checked = Object.entries(rows).filter(([, row]) => row.files > 0 && (wantedLanguages !== undefined || row.profiled));
  const gates: Record<string, GateResult[]> = Object.fromEntries(checked.map(([id, row]) => [id, gatesFor(id, row, baseline?.[id])]));
  // A language named by --languages but absent from the selected corpus cannot pass silently.
  for (const id of wantedLanguages ?? []) {
    if (rows[id]!.files === 0) gates[id] = [{ gate: 'files', value: 0, limit: '> 0', passed: false }];
  }
  const report = {
    schemaVersion: 1, kind: 'language-structure', createdAt: new Date().toISOString(), environment: environment(),
    chunkers: { syntax: SYNTAX_CHUNKER_VERSIONS, lineWindows: LINE_WINDOW_CHUNKER_VERSION },
    limits: DEFAULT_WINDOW_LIMITS, corpus: perRepository, excluded, groups: rows, gates,
  };
  const percent = (value: number | null): string => value === null ? '-' : `${(value * 100).toFixed(1)}%`;
  console.table(Object.fromEntries(Object.entries(rows).filter(([, row]) => row.files > 0).map(([id, row]) => [id, {
    profiled: row.profiled ? 'yes' : 'no', files: row.files, lines: row.lines, fragments: row.fragments,
    labelled: percent(row.labelledShare), '<=3 lines': percent(row.smallFragmentShare), midBlock: percent(row.midBlockShare),
    detachedAttr: row.detachedAttributeFragments, hidden: percent(row.declarationsHiddenShare), split: row.splitCallables,
    splitWithDecl: percent(row.splitCallablesWithDeclarationShare), contUnlabelled: percent(row.continuationsUnlabelledShare),
    fallback: row.parseFallbackFiles, 'ms/kLOC': row.chunkingMsPer1000Lines, uncovered: row.uncoveredNonBlankLines,
  }])));
  console.log(`-> ${writeReport(values.output ?? 'benchmark-results/languages.json', report)}`);
  if (values.check === true) {
    const failed = Object.entries(gates).flatMap(([id, results]) => results.filter((result) => !result.passed).map((result) => ({ id, ...result })));
    for (const failure of failed) console.error(`gate failed: ${failure.id} ${failure.gate} = ${String(failure.value)} (needs ${failure.limit})`);
    if (Object.keys(gates).length === 0) failed.push({ id: '-', gate: 'files', value: 0, limit: 'a measured language', passed: false });
    console.log(failed.length === 0 ? `gates: ${String(checked.length)} language(s) pass` : `gates: ${String(failed.length)} failure(s)`);
    if (failed.length > 0) process.exitCode = 1;
  }
}
