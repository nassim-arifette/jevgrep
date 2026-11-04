import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, treeHash } from './common.ts';
import type { Evidence } from './dataset.ts';

export type RealSplit = 'dev' | 'heldout';
export type RealCategory = 'change-localization' | 'code-understanding' | 'no-answer' | 'false-premise';
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
  // JS/TS tasks (SWE-bench Multilingual) for chunking experiments; only library sources are kept.
  'preactjs/preact': {
    url: 'https://github.com/preactjs/preact.git', split: 'dev', exclude: ['test/', 'demo/', 'benches/', 'mangle.json'],
    include: ['src/', 'hooks/src/', 'compat/src/', 'debug/src/', 'devtools/src/', 'jsx-runtime/src/', 'test-utils/src/'],
  },
  'axios/axios': { url: 'https://github.com/axios/axios.git', split: 'heldout', exclude: [], include: ['lib/', 'index.d.ts', 'index.js'] },
  // Go and Rust tasks (SWE-bench Multilingual) for Tree-sitter chunking experiments. Only
  // non-test sources are kept, and patch edits outside them (changelogs, lockfiles) are dropped.
  'caddyserver/caddy': {
    url: 'https://github.com/caddyserver/caddy.git', split: 'dev', exclude: ['caddytest/', 'cmd/', 'internal/', 'modules/', 'notify/'],
    excludeFiles: /_test\.go$|(^|\/)testdata\/|\.(?!go$)[^./]+$|^[^.]+$/, patchFiles: /\.go$/,
  },
  'gin-gonic/gin': {
    url: 'https://github.com/gin-gonic/gin.git', split: 'heldout', exclude: ['examples/', 'docs/', 'testdata/'],
    excludeFiles: /_test\.go$|(^|\/)testdata\/|\.(?!go$)[^./]+$|^[^.]+$/, patchFiles: /\.go$/,
  },
  'sharkdp/bat': { url: 'https://github.com/sharkdp/bat.git', split: 'dev', exclude: [], include: ['src/'], excludeFiles: /\.(?!rs$)[^./]+$|^[^.]+$/, patchFiles: /\.rs$/ },
  'tokio-rs/axum': {
    url: 'https://github.com/tokio-rs/axum.git', split: 'heldout', exclude: [], include: ['axum/src/', 'axum-extra/src/', 'axum-core/src/'],
    excludeFiles: /\.(?!rs$)[^./]+$|^[^.]+$/, patchFiles: /\.rs$/,
  },
  // Large repositories (> 1 M tokens of sources) and a Java set for the hard benchmark.
  // Only non-test sources of the main language are kept.
  'prometheus/prometheus': {
    url: 'https://github.com/prometheus/prometheus.git', split: 'dev', exclude: ['web/ui/', 'docs/', 'documentation/', 'vendor/', 'scripts/'],
    excludeFiles: /_test\.go$|(^|\/)testdata\/|\.(?!go$)[^./]+$|^[^.]+$/, patchFiles: /\.go$/,
  },
  'gohugoio/hugo': {
    url: 'https://github.com/gohugoio/hugo.git', split: 'heldout', exclude: ['docs/', 'testscripts/', 'examples/', 'vendor/'],
    excludeFiles: /_test\.go$|(^|\/)testdata\/|\.(?!go$)[^./]+$|^[^.]+$/, patchFiles: /\.go$/,
  },
  'nushell/nushell': {
    url: 'https://github.com/nushell/nushell.git', split: 'dev', exclude: [], include: ['crates/', 'src/'],
    excludeFiles: /(^|\/)tests?\/|(^|\/)benches\/|\.(?!rs$)[^./]+$|^[^.]+$/, patchFiles: /\.rs$/,
  },
  'astral-sh/ruff': {
    url: 'https://github.com/astral-sh/ruff.git', split: 'heldout', exclude: [], include: ['crates/'],
    excludeFiles: /(^|\/)tests?\/|(^|\/)resources\/|(^|\/)snapshots\/|(^|\/)benches\/|\.(?!rs$)[^./]+$|^[^.]+$/, patchFiles: /\.rs$/,
  },
  'projectlombok/lombok': {
    url: 'https://github.com/projectlombok/lombok.git', split: 'dev', exclude: [], include: ['src/'],
    excludeFiles: /\.(?!java$)[^./]+$|^[^.]+$/, patchFiles: /\.java$/,
  },
  'apache/lucene': {
    url: 'https://github.com/apache/lucene.git', split: 'heldout', exclude: [], include: ['lucene/'],
    excludeFiles: /\/src\/test\/|(^|\/)test-framework\/|(^|\/)benchmark\/|\.(?!java$)[^./]+$|^[^.]+$/, patchFiles: /\.java$/,
  },
} as const satisfies Record<string, {
  url: string; split: RealSplit; exclude: readonly string[]; include?: readonly string[];
  /** Paths dropped from the export even under an included prefix. */
  excludeFiles?: RegExp;
  /** Patch files outside this pattern carry no evidence and are ignored instead of disqualifying the task. */
  patchFiles?: RegExp;
}>;
export type RealRepository = keyof typeof realRepositories;

export const manifestPath = join(projectRoot, 'benchmarks/real-tasks/swe-bench-sample-1.json');
export const auditPath = join(projectRoot, 'benchmarks/real-tasks/audit.json');
export const javascriptManifestPath = join(projectRoot, 'benchmarks/real-tasks/swe-bench-multilingual-js-1.json');
export const systemsManifestPath = join(projectRoot, 'benchmarks/real-tasks/swe-bench-multilingual-go-rust-1.json');
export const reliabilityManifestPath = join(projectRoot, 'benchmarks/real-tasks/hand-go-rust-reliability-1.json');
export const hardManifestPath = join(projectRoot, 'benchmarks/real-tasks/swe-bench-multilingual-hard-1.json');

const isTestPath = (path: string): boolean =>
  /(^|\/)(tests?|testing|__tests__)(\/|$)|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
const isJavaScript = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path);
type BraceLanguage = 'go' | 'rust';
const braceLanguageOf = (path: string): BraceLanguage | null => path.endsWith('.go') ? 'go' : path.endsWith('.rs') ? 'rust' : null;
type RepositoryEntry = {
  readonly exclude: readonly string[]; readonly include?: readonly string[]; readonly excludeFiles?: RegExp; readonly patchFiles?: RegExp;
};
const entryOf = (repository: RealRepository): RepositoryEntry => realRepositories[repository];
export const excluded = (repository: RealRepository, path: string): boolean => {
  const entry = entryOf(repository);
  return entry.exclude.some((prefix) => path.startsWith(prefix)) || (entry.include !== undefined && !entry.include.some((prefix) => path.startsWith(prefix)))
    || (entry.excludeFiles?.test(path) ?? false);
};

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

/** Lines inside JS/TS block comments, line comments, or blank. */
function javascriptDocumentationLines(text: string): Set<number> {
  const result = new Set<number>();
  let open = false;
  text.split(/\r?\n/).forEach((line, index) => {
    const startsOpen = open;
    let rest = line;
    for (;;) {
      const marker = open ? rest.indexOf('*/') : rest.indexOf('/*');
      if (marker === -1) break;
      open = !open;
      rest = rest.slice(marker + 2);
    }
    if (startsOpen || open || /^\s*(\/\/|\/\*.*\*\/\s*$|$)/.test(line) || (startsOpen && /^\s*\*/.test(line))) result.add(index + 1);
  });
  return result;
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
        const match = /("""|''')/.exec(rest);
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
    if (startsOpen || open !== null || /^\s*(#|$)/.test(line) || /^\s*[rRuU]?("""|''').*("""|''')\s*$/.test(line)) result.add(index + 1);
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
export function classifyHunk(hunk: Hunk, preChangeText: string, path = ''): HunkRole {
  const squash = (lines: readonly string[]): string => lines.map((line) => line.replace(/\s+/g, '')).join('\n');
  if (squash(hunk.removed) === squash(hunk.added)) return 'ignored';
  const changed = [...hunk.removed, ...hunk.added].filter((line) => line.trim() !== '');
  if (isJavaScript(path)) return classifyJavaScriptHunk(hunk, changed, preChangeText);
  const brace = braceLanguageOf(path);
  if (brace !== null) return classifyBraceHunk(hunk, changed, preChangeText, brace);
  if (changed.every((line) => importLine.test(line)) && changed.some((line) => /\bimport\b/.test(line))) return 'ignored';
  const documentation = documentationLines(preChangeText);
  const inside = (line: number): boolean => documentation.has(line) && (hunk.removed.length > 0 || documentation.has(line + 1));
  if (hunk.lines.every(inside)) return 'ignored';
  if (hunk.removed.length === 0 && /^\s*(@|(async\s+)?def\s|class\s)/.test(hunk.added.find((line) => line.trim() !== '') ?? '')) return 'placement';
  return 'edit';
}

const javascriptImportLine = /^\s*(?:import\s|export\s.*\bfrom\s|(?:const|let|var)\s.*=\s*require\(|[\w$]+(?:\s+as\s+[\w$]+)?,?\s*$|\}\s*from\s)/;

function classifyJavaScriptHunk(hunk: Hunk, changed: readonly string[], preChangeText: string): HunkRole {
  if (changed.every((line) => javascriptImportLine.test(line)) && changed.some((line) => /\b(import|require)\b|\bfrom\s/.test(line))) return 'ignored';
  const documentation = javascriptDocumentationLines(preChangeText);
  const inside = (line: number): boolean => documentation.has(line) && (hunk.removed.length > 0 || documentation.has(line + 1));
  if (hunk.lines.every(inside)) return 'ignored';
  const first = hunk.added.find((line) => line.trim() !== '') ?? '';
  if (hunk.removed.length === 0 && /^\s*(@|\/\*\*|(export\s+)?(default\s+)?(async\s+)?(function|class)\b)/.test(first)) return 'placement';
  return 'edit';
}

const braceImport: Readonly<Record<BraceLanguage, { line: RegExp; keyword: RegExp; definition: RegExp }>> = {
  go: {
    line: /^\s*(?:import\b.*|\(|\)|(?:[\w.]+\s+)?"[^"]*")\s*$/, keyword: /^\s*import\b|^\s*(?:[\w.]+\s+)?"[^"]*"\s*$/,
    definition: /^\s*(?:\/\/|func\s|type\s)/,
  },
  rust: {
    line: /^\s*(?:(?:pub(?:\([^)]*\))?\s+)?(?:use|extern\s+crate)\s.*|[\w:{}*, ]+,?|\};?)\s*$/, keyword: /\b(?:use|extern\s+crate)\s/,
    definition: /^\s*(?:\/\/[/!]|#\[|(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl|mod|type)\b)/,
  },
};

/** Go and Rust hunks: C-style comments are documentation, `import`/`use` lists are imports. */
function classifyBraceHunk(hunk: Hunk, changed: readonly string[], preChangeText: string, language: BraceLanguage): HunkRole {
  const rules = braceImport[language];
  if (changed.every((line) => rules.line.test(line)) && changed.some((line) => rules.keyword.test(line))) return 'ignored';
  const documentation = javascriptDocumentationLines(preChangeText);
  const inside = (line: number): boolean => documentation.has(line) && (hunk.removed.length > 0 || documentation.has(line + 1));
  if (hunk.lines.every(inside)) return 'ignored';
  if (hunk.removed.length === 0 && rules.definition.test(hunk.added.find((line) => line.trim() !== '') ?? '')) return 'placement';
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

const braceFunction: Readonly<Record<BraceLanguage, RegExp>> = {
  go: /^func\s+(?:\([^)]*\)\s*)?(\w+)/,
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/,
};

/** Braces of one line, ignoring line comments, string and rune/char literals. */
function braceDelta(line: string): { readonly opens: number; readonly closes: number } {
  const code = line.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)'/g, '""').replace(/\/\/.*$/, '');
  return { opens: code.split('{').length - 1, closes: code.split('}').length - 1 };
}

/**
 * The innermost Go or Rust function enclosing `line` and the first sentence of its doc
 * comment. A Go doc comment that starts with the function name drops it, so the question
 * does not quote the identifier it asks for.
 */
export function enclosingBraceFunction(text: string, line: number, language: BraceLanguage): { startLine: number; endLine: number; name: string; summary: string | null } | null {
  const lines = text.split(/\r?\n/);
  for (let index = Math.min(line, lines.length) - 1; index >= 0; index -= 1) {
    const match = braceFunction[language].exec(lines[index]!);
    if (!match) continue;
    let depth = 0;
    let opened = false;
    let end = -1;
    for (let next = index; next < lines.length && end === -1; next += 1) {
      const { opens, closes } = braceDelta(lines[next]!);
      if (!opened && opens === 0 && /;\s*$/.test(lines[next]!)) break;
      if (opens > 0) opened = true;
      depth += opens - closes;
      if (opened && depth <= 0) end = next;
    }
    if (end === -1 || end + 1 < line) continue;
    return { startLine: index + 1, endLine: end + 1, name: match[1]!, summary: docCommentSummary(lines, index, match[1]!, language) };
  }
  return null;
}

function docCommentSummary(lines: readonly string[], header: number, name: string, language: BraceLanguage): string | null {
  const marker = language === 'go' ? /^\s*\/\/(?!\/)\s?(.*)$/ : /^\s*\/\/\/(?!\/)\s?(.*)$/;
  let index = header - 1;
  while (language === 'rust' && index >= 0 && /^\s*#\[/.test(lines[index]!)) index -= 1;
  const parts: string[] = [];
  for (; index >= 0; index -= 1) {
    const comment = marker.exec(lines[index]!);
    if (!comment) break;
    parts.unshift(comment[1]!);
  }
  const paragraph = parts.join('\n').split(/\n\s*\n/)[0]!;
  let text = paragraph.replace(/\[`?([^\]`]*)`?\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
  if (language === 'go' && text.startsWith(`${name} `)) text = text.slice(name.length + 1);
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
  const patchFiles = entryOf(repository).patchFiles;
  const diffs = parsePatch(instance.patch).filter((file) => patchFiles === undefined || patchFiles.test(file.path));
  if (diffs.some((file) => file.isNew || isTestPath(file.path) || excluded(repository, file.path) || files[file.path] === undefined)) return null;
  const roles = diffs.map((file) => ({ file, roles: file.hunks.map((hunk) => classifyHunk(hunk, files[file.path]!, file.path)) }));
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
  // Docstring and doc-comment questions exist for Python, Go and Rust only.
  const brace = braceLanguageOf(first.path);
  const enclosing = first.path.endsWith('.py') ? enclosingFunction(files[first.path]!, first.startLine)
    : brace !== null ? enclosingBraceFunction(files[first.path]!, first.startLine, brace) : null;
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
