import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, treeHash } from './common.ts';
import type { Evidence } from './dataset.ts';

export type RealSplit = 'dev' | 'heldout';
export type RealCategory = 'change-localization' | 'code-understanding';
export type LabelSource = 'patch' | 'docstring' | 'test-patch' | 'audit';

export type RealQuery = {
  readonly id: string;
  readonly category: RealCategory;
  readonly query: string;
  /** Required units; recall is measured against these. */
  readonly evidence: readonly Evidence[];
  /** Useful but not required: excerpts here are never counted as misses or errors. */
  readonly complementary: readonly Evidence[];
  readonly label: LabelSource;
};

export type RealTask = {
  readonly id: string;
  readonly repository: RealRepository;
  readonly split: RealSplit;
  readonly baseCommit: string;
  readonly snapshotHash: string;
  readonly createdAt: string;
  readonly queries: readonly RealQuery[];
};

export type AuditEntry = {
  readonly verdict: 'accepted' | 'amended' | 'rejected';
  readonly note: string;
  readonly evidence?: readonly Evidence[];
  readonly complementary?: readonly Evidence[];
};

export type RealManifest = {
  readonly version: string;
  readonly source: { readonly dataset: string; readonly split: string; readonly license: string; readonly revision: string | null };
  readonly selection: { readonly seed: string; readonly perRepository: Readonly<Record<string, number>>; readonly maxEditFiles: number; readonly maxQueryBytes: number };
  readonly tasks: readonly RealTask[];
};

/** Development and held-out evaluation never share a repository. */
export const realRepositories = {
  'psf/requests': { url: 'https://github.com/psf/requests.git', split: 'dev', exclude: ['requests/packages/', 'docs/', 'ext/'] },
  'pallets/flask': { url: 'https://github.com/pallets/flask.git', split: 'heldout', exclude: ['docs/', 'examples/', 'artwork/'] },
} as const satisfies Record<string, { url: string; split: RealSplit; exclude: readonly string[] }>;
export type RealRepository = keyof typeof realRepositories;

export const manifestPath = join(projectRoot, 'benchmarks/real-tasks/swe-bench-sample-1.json');
export const auditPath = join(projectRoot, 'benchmarks/real-tasks/audit.json');

const isTestPath = (path: string): boolean => /(^|\/)(tests?|testing)(\/|$)|(^|\/)test_[^/]*\.py$|_test\.py$/.test(path);
export const excluded = (repository: RealRepository, path: string): boolean =>
  realRepositories[repository].exclude.some((prefix) => path.startsWith(prefix));

export type Hunk = { readonly removed: readonly string[]; readonly added: readonly string[]; readonly lines: readonly number[] };
export type FileDiff = { readonly path: string; readonly isNew: boolean; readonly hunks: readonly Hunk[] };

/**
 * Pre-change line numbers touched by each hunk of a unified diff. A deletion marks its
 * own line; an insertion marks the preceding pre-change line.
 */
export function parsePatch(patch: string): FileDiff[] {
  const files: { path: string; isNew: boolean; hunks: { removed: string[]; added: string[]; lines: number[] }[] }[] = [];
  let oldLine = 0;
  for (const line of patch.split('\n')) {
    const current = files.at(-1);
    const hunk = current?.hunks.at(-1);
    if (line.startsWith('diff --git ')) {
      files.push({ path: line.split(' b/').at(-1)!, isNew: false, hunks: [] });
    } else if (current && current.hunks.length === 0 && line.startsWith('--- ')) {
      current.isNew = line === '--- /dev/null';
    } else if (current && current.hunks.length === 0 && line.startsWith('+++ ')) {
      continue;
    } else if (current && line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!match) throw new Error(`malformed hunk header: ${line}`);
      oldLine = Number(match[1]);
      current.hunks.push({ removed: [], added: [], lines: [] });
    } else if (hunk) {
      if (line.startsWith('-')) { hunk.removed.push(line.slice(1)); hunk.lines.push(oldLine); oldLine += 1; }
      else if (line.startsWith('+')) { hunk.added.push(line.slice(1)); hunk.lines.push(Math.max(1, oldLine - 1)); }
      else if (line.startsWith(' ') || line === '') oldLine += 1;
    }
  }
  return files;
}

/** Pre-change lines inside a Python docstring or on a comment line. */
function documentationLines(text: string): Set<number> {
  const lines = text.split(/\r?\n/);
  const result = new Set<number>();
  let open: string | null = null;
  lines.forEach((line, index) => {
    const startsOpen = open !== null;
    let rest = line;
    for (;;) {
      if (open === null) {
        const match = /("""|\'\'\')/.exec(rest);
        if (!match) break;
        open = match[1]!;
        rest = rest.slice(match.index + 3);
      } else {
        const close = rest.indexOf(open);
        if (close === -1) break;
        open = null;
        rest = rest.slice(close + 3);
      }
    }
    if (startsOpen || open !== null || /^\s*(#|$)/.test(line) || /^\s*[rRuU]?("""|\'\'\').*("""|\'\'\')\s*$/.test(line)) result.add(index + 1);
  });
  return result;
}

export type HunkRole = 'edit' | 'placement' | 'ignored';

const importName = String.raw`\w+(?:\s+as\s+\w+)?`;
/** An import statement, or a continuation line listing imported names: `a, b as c,` or `d)`. */
const importLine = new RegExp(String.raw`^\s*(?:from\s+\S+\s+import\b|import\s|(?:${importName}\s*,\s*)*(?:${importName}\s*,?)?\s*\)?\s*$)`);

/**
 * Whitespace-only, import-only and documentation-only hunks are ignored. A pure
 * insertion of a new `def`/`class` only marks where new code was placed.
 */
export function classifyHunk(hunk: Hunk, preChangeText: string): HunkRole {
  const squash = (lines: readonly string[]): string => lines.map((line) => line.replace(/\s+/g, '')).join('\n');
  if (squash(hunk.removed) === squash(hunk.added)) return 'ignored';
  const changed = [...hunk.removed, ...hunk.added].filter((line) => line.trim() !== '');
  if (changed.every((line) => importLine.test(line)) && changed.some((line) => /\bimport\b/.test(line))) return 'ignored';
  const documentation = documentationLines(preChangeText);
  const inside = (line: number): boolean => documentation.has(line) && (hunk.removed.length > 0 || documentation.has(line + 1));
  if (hunk.lines.every(inside)) return 'ignored';
  if (hunk.removed.length === 0 && /^\s*(@|(async\s+)?def\s|class\s)/.test(hunk.added.find((line) => line.trim() !== '') ?? '')) return 'placement';
  return 'edit';
}

/** Merge touched lines separated by at most `gap` untouched lines into evidence units. */
export function unitsFromLines(path: string, lines: readonly number[], gap = 2): Evidence[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const units: Evidence[] = [];
  for (const line of sorted) {
    const last = units.at(-1);
    if (last && line <= last.endLine + gap + 1) units[units.length - 1] = { ...last, endLine: Math.max(last.endLine, line) };
    else units.push({ path, startLine: line, endLine: line });
  }
  return units;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The innermost Python `def` enclosing `line`, with decorators, and its docstring's first sentence. */
export function enclosingFunction(text: string, line: number): { startLine: number; endLine: number; name: string; summary: string | null } | null {
  const lines = text.split(/\r?\n/);
  let limit = Infinity;
  for (let index = Math.min(line, lines.length) - 1; index >= 0; index -= 1) {
    const current = lines[index]!;
    if (current.trim() === '') continue;
    const indent = indentOf(current);
    const match = /^\s*(?:async\s+)?def\s+(\w+)/.exec(current);
    if (match && indent < limit) {
      let start = index;
      while (start > 0 && /^\s*@/.test(lines[start - 1]!) && indentOf(lines[start - 1]!) === indent) start -= 1;
      let signatureEnd = index;
      while (signatureEnd < lines.length - 1 && !/:\s*(#.*)?$/.test(lines[signatureEnd]!)) signatureEnd += 1;
      let end = signatureEnd;
      for (let next = signatureEnd + 1; next < lines.length; next += 1) {
        if (lines[next]!.trim() === '') continue;
        if (indentOf(lines[next]!) <= indent) break;
        end = next;
      }
      if (index + 1 === line || end + 1 >= line) {
        return { startLine: start + 1, endLine: end + 1, name: match[1]!, summary: docstringSummary(lines, signatureEnd + 1) };
      }
    }
    if (index + 1 < line) limit = Math.min(limit, indent);
  }
  return null;
}

function docstringSummary(lines: readonly string[], from: number): string | null {
  let index = from;
  while (index < lines.length && lines[index]!.trim() === '') index += 1;
  const opening = /^\s*[rRuU]?("""|''')(.*)$/.exec(lines[index] ?? '');
  if (!opening) return null;
  const quote = opening[1]!;
  const parts: string[] = [];
  let rest = opening[2]!;
  for (;;) {
    const close = rest.indexOf(quote);
    if (close !== -1) { parts.push(rest.slice(0, close)); break; }
    parts.push(rest);
    index += 1;
    if (index >= lines.length) return null;
    rest = lines[index]!;
  }
  const text = parts.join(' ').replace(/:\w+:`~?([^`]*)`/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
  const sentence = text.split(/(?<=\.)\s/)[0]!.trim();
  return sentence.split(' ').length >= 5 ? sentence : null;
}

/** Path from a pax extended header, whose records are `<length> <key>=<value>\n`. */
function paxPath(body: Buffer): string | null {
  let path: string | null = null;
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(0x20, offset);
    const length = space === -1 ? Number.NaN : Number(body.toString('latin1', offset, space));
    if (!Number.isSafeInteger(length) || length <= space - offset) break;
    const record = body.toString('utf8', space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/**
 * Regular files of a `git archive --format=tar` stream, read in memory so no external
 * `tar` or shell is involved. Directories, links and pax headers are not files; a pax
 * `path` record names the entry that follows it.
 */
export function tarFiles(archive: Buffer): { readonly path: string; readonly bytes: Buffer }[] {
  const files: { path: string; bytes: Buffer }[] = [];
  let longPath: string | null = null;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => {
      const end = header.indexOf(0, start);
      return header.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
    };
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || offset + 512 + size > archive.length) throw new Error('malformed tar entry');
    const type = field(156, 1) || '0';
    const body = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { longPath = paxPath(body); continue; }
    const prefix = field(345, 155);
    const path = longPath ?? (prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`);
    longPath = null;
    if (type === '0') files.push({ path, bytes: body });
  }
  return files;
}

/** Deterministic, visibility-bounded export of one pre-change snapshot. Links, binaries and excluded paths are dropped. */
export async function exportSnapshot(mirror: string, repository: RealRepository, commit: string): Promise<Record<string, string>> {
  // Line endings follow the tree's own attributes, never this host's autocrlf/eol settings,
  // so pinned snapshot hashes reproduce on every platform.
  const { stdout } = await promisify(execFile)('git', [
    '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', mirror, 'archive', '--format=tar', commit,
  ], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
  const files: Record<string, string> = {};
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const { path, bytes } of tarFiles(stdout)) {
    if (bytes.length > 1_000_000 || excluded(repository, path) || bytes.includes(0)) continue;
    try { files[path] = decoder.decode(bytes); } catch { /* not UTF-8 */ }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export type SweInstance = {
  readonly instance_id: string; readonly repo: string; readonly base_commit: string;
  readonly patch: string; readonly test_patch: string; readonly problem_statement: string; readonly created_at: string;
};

export const changeQuery = (statement: string): string => `Which existing code must change to resolve this issue?\n\n${statement.trim()}`;
export const understandingQuery = (summary: string): string => `Where is the code that does this: ${summary}`;
const rank = (seed: string, id: string): string => createHash('sha256').update(`${seed}:${id}`).digest('hex');

/** Build one task from an instance and its snapshot; null when it falls outside the bounded selection policy. */
export function buildTask(instance: SweInstance, files: Readonly<Record<string, string>>, maxEditFiles: number, maxQueryBytes: number): RealTask | null {
  const repository = instance.repo as RealRepository;
  const query = changeQuery(instance.problem_statement);
  if (Buffer.byteLength(query, 'utf8') > maxQueryBytes) return null;
  const diffs = parsePatch(instance.patch);
  if (diffs.some((file) => file.isNew || isTestPath(file.path) || excluded(repository, file.path) || files[file.path] === undefined)) return null;
  const roles = diffs.map((file) => ({ file, roles: file.hunks.map((hunk) => classifyHunk(hunk, files[file.path]!)) }));
  const touched = (role: HunkRole): Evidence[] => roles.flatMap(({ file, roles: kinds }) =>
    unitsFromLines(file.path, file.hunks.flatMap((hunk, index) => kinds[index] === role ? hunk.lines : [])));
  const edit = touched('edit');
  const placement = touched('placement');
  const evidence = edit.length > 0 ? edit : placement;
  const editFiles = new Set(evidence.map((unit) => unit.path));
  if (evidence.length === 0 || editFiles.size > maxEditFiles) return null;
  const tests = parsePatch(instance.test_patch)
    .filter((file) => !file.isNew && files[file.path] !== undefined)
    .flatMap((file) => unitsFromLines(file.path, file.hunks.flatMap((hunk) => hunk.lines)));
  const complementary = [...(edit.length > 0 ? placement : []), ...tests];
  const queries: RealQuery[] = [{ id: `${instance.instance_id}:change`, category: 'change-localization', query, evidence, complementary, label: 'patch' }];
  const first = evidence[0]!;
  const enclosing = enclosingFunction(files[first.path]!, first.startLine);
  if (enclosing?.summary) {
    queries.push({
      id: `${instance.instance_id}:understand`, category: 'code-understanding', query: understandingQuery(enclosing.summary),
      evidence: [{ path: first.path, startLine: enclosing.startLine, endLine: enclosing.endLine }], complementary: [], label: 'docstring',
    });
  }
  return {
    id: instance.instance_id, repository, split: realRepositories[repository].split, baseCommit: instance.base_commit,
    snapshotHash: treeHash(files), createdAt: instance.created_at, queries,
  };
}

/** Stable per-repository order; the first eligible `count` tasks are selected. */
export function orderInstances(instances: readonly SweInstance[], seed: string): SweInstance[] {
  return [...instances].sort((a, b) => rank(seed, a.instance_id) < rank(seed, b.instance_id) ? -1 : 1);
}

export function loadAudit(path = auditPath): Readonly<Record<string, AuditEntry>> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, AuditEntry>;
}

/** Apply reviewed label amendments; rejected queries are removed. */
export function applyAudit(manifest: RealManifest, audit: Readonly<Record<string, AuditEntry>>): RealManifest {
  for (const id of Object.keys(audit)) {
    if (!manifest.tasks.some((task) => task.queries.some((query) => query.id === id))) throw new Error(`audit entry for unknown query ${id}`);
  }
  return {
    ...manifest,
    tasks: manifest.tasks.map((task) => ({
      ...task,
      queries: task.queries.flatMap((query) => {
        const entry = audit[query.id];
        if (!entry) return [query];
        if (entry.verdict === 'rejected') return [];
        if (entry.verdict === 'accepted') return [query];
        return [{ ...query, evidence: entry.evidence ?? query.evidence, complementary: entry.complementary ?? query.complementary, label: 'audit' as const }];
      }),
    })),
  };
}

export function loadManifest(path = manifestPath, audit: Readonly<Record<string, AuditEntry>> = loadAudit()): RealManifest {
  return applyAudit(JSON.parse(readFileSync(path, 'utf8')) as RealManifest, audit);
}

/** Bare mirrors of the pinned repositories, cloned once under an ignored directory. */
export async function ensureMirror(root: string, repository: RealRepository): Promise<string> {
  const path = join(root, `${repository.replace('/', '__')}.git`);
  try { lstatSync(path); } catch {
    await promisify(execFile)('git', ['clone', '--quiet', '--bare', realRepositories[repository].url, path]);
  }
  return path;
}

/** Run `work` over `items` with at most `limit` in flight, preserving input order in the result. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!, index);
    }
  }));
  return results;
}

/** Every evidence range must lie inside a file of its pinned snapshot. */
export function validateTask(task: RealTask, files: Readonly<Record<string, string>>): void {
  if (treeHash(files) !== task.snapshotHash) throw new Error(`${task.id}: snapshot hash mismatch`);
  if (realRepositories[task.repository].split !== task.split) throw new Error(`${task.id}: split must follow its repository`);
  for (const query of task.queries) {
    for (const unit of [...query.evidence, ...query.complementary]) {
      const text = files[unit.path];
      const lines = text === undefined ? 0 : text.split(/\r?\n/).length;
      if (unit.startLine < 1 || unit.endLine < unit.startLine || unit.endLine > lines) throw new Error(`${query.id}: evidence outside ${unit.path}`);
    }
  }
}
