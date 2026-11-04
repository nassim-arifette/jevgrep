/**
 * Cache-identity reuse experiment (roadmap: additional cache-identity investigation).
 *
 * Walks consecutive first-parent commits of a git repository, chunks every source
 * file the commit touched with the production chunker before and after, and counts how
 * many fragments of the new version a score cache could reuse under three identities:
 *
 *   location   path + line range + text + label (the current cache identity)
 *   path       path + text + label (a layout without the `Lines:` header)
 *   content    text + label (a layout without `File:` and `Lines:` headers)
 *
 * Only local work: no provider request is made.
 *
 *   node scripts/bench-cache-identity.ts --repo cobra=/path/to/cobra --commits 200
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { chunkSnapshot, usesSyntaxChunking } from '../src/source/chunker.ts';
import { createSnapshot } from '../src/source/snapshot.ts';
import { countReferenceTokens } from '../src/response/token-counter.ts';
import { environment, positiveInteger, writeReport } from './bench/common.ts';

type Key = 'location' | 'path' | 'content';
const KEYS: readonly Key[] = ['location', 'path', 'content'];

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function show(repo: string, revision: string, path: string): Buffer | null {
  try { return execFileSync('git', ['-C', repo, 'show', `${revision}:${path}`], { maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

function keys(path: string, bytes: Buffer | null): Record<Key, string[]> {
  const out: Record<Key, string[]> = { location: [], path: [], content: [] };
  if (bytes === null) return out;
  let result;
  try { result = chunkSnapshot(createSnapshot(path, path, bytes, countReferenceTokens)); }
  catch { return out; }
  if (result.kind !== 'fragments') return out;
  for (const fragment of result.fragments) {
    const label = fragment.label ?? null;
    out.location.push(JSON.stringify([path, fragment.startLine, fragment.endLine, fragment.text, label]));
    out.path.push(JSON.stringify([path, fragment.text, label]));
    out.content.push(JSON.stringify([fragment.text, label]));
  }
  return out;
}

const { values } = parseArgs({ options: { repo: { type: 'string', multiple: true }, commits: { type: 'string' }, output: { type: 'string' } } });
const limit = positiveInteger(values.commits, 200);
const results = [];
for (const entry of values.repo ?? []) {
  const [name, repo] = entry.split('=') as [string, string];
  const commits = git(repo, 'rev-list', '--first-parent', '--no-merges', `--max-count=${String(limit)}`, 'HEAD').trim().split('\n');
  const totals = { commits: 0, touchedFiles: 0, fragments: 0, reusable: { location: 0, path: 0, content: 0 } };
  for (const commit of commits) {
    const parent = `${commit}^`;
    let diff: string;
    try { diff = git(repo, 'diff', '--name-status', '-M', '--no-renames', parent, commit); } catch { continue; }
    // Renames are kept as delete + add so a moved file is looked up across the whole old commit.
    const changed = diff.trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
      .filter(([status, path]) => status !== 'D' && path !== undefined && usesSyntaxChunking(path)).map(([, path]) => path!);
    if (changed.length === 0) continue;
    const deleted = diff.trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
      .filter(([status, path]) => status === 'D' && path !== undefined && usesSyntaxChunking(path)).map(([, path]) => path!);
    // Content can move from any touched or deleted file of the parent commit.
    const before: Record<Key, Set<string>> = { location: new Set(), path: new Set(), content: new Set() };
    for (const path of [...changed, ...deleted]) {
      const old = keys(path, show(repo, parent, path));
      for (const key of KEYS) for (const value of old[key]) before[key].add(value);
    }
    totals.commits += 1;
    for (const path of changed) {
      const next = keys(path, show(repo, commit, path));
      totals.touchedFiles += 1;
      totals.fragments += next.location.length;
      for (const key of KEYS) totals.reusable[key] += next[key].filter((value) => before[key].has(value)).length;
    }
  }
  const share = (key: Key) => Number((totals.reusable[key] / Math.max(1, totals.fragments)).toFixed(3));
  const row = { repository: name, ...totals, reuse: { location: share('location'), path: share('path'), content: share('content') } };
  console.log(JSON.stringify(row));
  results.push(row);
}
if (values.output !== undefined) writeReport(values.output, { environment: environment(), results });
