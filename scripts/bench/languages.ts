import { execFile, spawn } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDefaultConfiguration } from '../../src/contracts.ts';
import { extensionOf, uncoveredNonBlankLines, type ChunkResult, type PreparedFragment } from '../../src/source/chunker.ts';
import { EligibilityRules } from '../../src/source/inventory.ts';
import type { SourceSnapshot } from '../../src/source/snapshot.ts';

/**
 * Offline structural language benchmark (language search spec 9.1). Pinned public
 * repositories are exported from local mirrors, filtered by the product's own
 * eligibility rules and chunked by the production chunker; every metric is a
 * structural fact about the fragments, never a retrieval score.
 */

export type CorpusRepository = {
  readonly name: string;
  readonly commit: string;
  /** Path prefixes dropped from the export: parser stress fixtures and vendored third-party code. */
  readonly exclude: readonly string[];
};

/** Spec 9.1, plus Polly for C#. Full commits so a shallow fetch can pin them. */
export const LANGUAGE_CORPUS: readonly CorpusRepository[] = [
  { name: 'django/django', commit: 'f14af5a88472ca10e2e94b37d6c17ee48cbdeb4d', exclude: [] },
  { name: 'spring-projects/spring-petclinic', commit: '500158f732419217507c7656904b8e6aa1bcc0d6', exclude: [] },
  { name: 'google/gson', commit: 'd9b5079eaa4567219771bba6d04289cf45c7589b', exclude: [] },
  { name: 'caddyserver/caddy', commit: '679806f92d49e5b494200f2e90a93f228203a418', exclude: [] },
  { name: 'sharkdp/bat', commit: '4bd5c5b602950ea8fe62ea16d851d6a26eccfb76', exclude: ['tests/syntax-tests/'] },
  { name: 'tokio-rs/axum', commit: 'bfa66864176ffc03e508d8a8afd33c2e626ac38d', exclude: [] },
  { name: 'expressjs/express', commit: '43fca52d28a422c8be48fd489cbd4f2d6152bab6', exclude: [] },
  { name: 'vuejs/core', commit: '44234e82bf4fcb234968061d7a51e37ea9f39e71', exclude: [] },
  { name: 'redis/redis', commit: 'f7c38e3973d4018ba290a4793b08c11cb2f7372f', exclude: ['deps/'] },
  { name: 'fmtlib/fmt', commit: '3be6709f575a609620f5dd82a9ab2fa91bef6a5e', exclude: [] },
  { name: 'laravel/framework', commit: '14b8b06051f11d919a549a400e7d4c6d8ed009af', exclude: [] },
  { name: 'sinatra/sinatra', commit: '2e3f79139154b8bfdaad7ad516f35dcb0e70446a', exclude: [] },
  { name: 'square/okio', commit: 'f0e3f479f83531332de076ed39bc001a5618d538', exclude: [] },
  { name: 'Alamofire/Alamofire', commit: 'dea4bab91767a971d6e112bc955c6a82295589b7', exclude: [] },
  { name: 'App-vNext/Polly', commit: 'ad7d87bf1c1cee65f4a90f1afb192094111df6eb', exclude: [] },
];

/** How declarations are delimited, for the heuristic declaration scan. */
type Delimiting = 'braces' | 'indentation' | 'end-keyword' | 'none';

export type LanguageGroup = {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly delimiting: Delimiting;
};

/** The extension groups of the spec tables, including languages that only get line windows. */
export const LANGUAGE_GROUPS: readonly LanguageGroup[] = [
  { id: 'typescript', extensions: ['.ts', '.tsx', '.mts', '.cts'], delimiting: 'braces' },
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], delimiting: 'braces' },
  { id: 'python', extensions: ['.py', '.pyi', '.pyw'], delimiting: 'indentation' },
  { id: 'java', extensions: ['.java'], delimiting: 'braces' },
  { id: 'go', extensions: ['.go'], delimiting: 'braces' },
  { id: 'rust', extensions: ['.rs'], delimiting: 'braces' },
  { id: 'c', extensions: ['.c', '.h'], delimiting: 'braces' },
  { id: 'cpp', extensions: ['.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.h++', '.ipp', '.tpp'], delimiting: 'braces' },
  { id: 'csharp', extensions: ['.cs'], delimiting: 'braces' },
  { id: 'php', extensions: ['.php'], delimiting: 'braces' },
  { id: 'kotlin', extensions: ['.kt', '.kts'], delimiting: 'braces' },
  { id: 'swift', extensions: ['.swift'], delimiting: 'braces' },
  { id: 'ruby', extensions: ['.rb', '.rake', '.gemspec'], delimiting: 'end-keyword' },
  { id: 'shell', extensions: ['.sh', '.bash', '.zsh'], delimiting: 'none' },
  { id: 'html', extensions: ['.html', '.htm'], delimiting: 'none' },
  { id: 'css', extensions: ['.css', '.scss', '.sass', '.less'], delimiting: 'none' },
  { id: 'yaml', extensions: ['.yml', '.yaml'], delimiting: 'none' },
  { id: 'json', extensions: ['.json', '.jsonc'], delimiting: 'none' },
  { id: 'markdown', extensions: ['.md', '.markdown'], delimiting: 'none' },
  { id: 'sql', extensions: ['.sql'], delimiting: 'none' },
  { id: 'toml', extensions: ['.toml'], delimiting: 'none' },
  { id: 'vue', extensions: ['.vue'], delimiting: 'none' },
];

const GROUP_BY_EXTENSION = new Map(LANGUAGE_GROUPS.flatMap((group) => group.extensions.map((extension) => [extension, group] as const)));
export const languageGroupOf = (path: string): LanguageGroup | null => GROUP_BY_EXTENSION.get(extensionOf(path)) ?? null;

/** A bare mirror holding the pinned commit, cloned like `bench:real` mirrors so either runner can reuse it. */
export async function ensureCorpusMirror(root: string, repository: CorpusRepository): Promise<string> {
  const git = (...args: string[]) => promisify(execFile)('git', args, { maxBuffer: 64 * 1024 * 1024 });
  const path = join(root, `${repository.name.replace('/', '__')}.git`);
  const url = `https://github.com/${repository.name}.git`;
  try { lstatSync(path); } catch {
    mkdirSync(root, { recursive: true });
    await git('clone', '--quiet', '--bare', url, path);
  }
  try { await git('-C', path, 'cat-file', '-e', `${repository.commit}^{commit}`); } catch {
    await git('-C', path, 'fetch', '--quiet', url, repository.commit);
  }
  return path;
}

const ELIGIBILITY = new EligibilityRules({
  respectGitignore: false, maxFileBytes: createDefaultConfiguration('/', 'benchmark').source.max_file_bytes, extraDenyGlobs: [],
});

/** Whether the inventory would offer this tracked path to preparation (content checks come later). */
export function eligiblePath(path: string, sizeBytes: number): boolean {
  const parts = path.split('/');
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (ELIGIBILITY.directoryExclusion(parts[index]!, parts.slice(0, index + 1).join('/')) !== null) return false;
  }
  return ELIGIBILITY.fileExclusion(parts.at(-1)!, path, sizeBytes) === null;
}

/** Run git with `input` on stdin and return its stdout. */
function gitWithInput(args: readonly string[], input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args.join(' ')} exited ${String(code)}`)));
    child.stdin.end(input);
  });
}

/**
 * Eligible files of the language groups at the pinned commit, as stored blobs, in path
 * order. Blobs are read from the tree rather than `git archive`, so `export-ignore`
 * attributes (Laravel drops its tests that way) do not shrink the corpus.
 */
export async function exportCorpus(mirror: string, repository: CorpusRepository): Promise<{ readonly path: string; readonly bytes: Buffer }[]> {
  const { stdout } = await promisify(execFile)('git', ['-C', mirror, 'ls-tree', '-r', '-z', '-l', repository.commit], { maxBuffer: 256 * 1024 * 1024 });
  const entries = stdout.split('\0').filter(Boolean).flatMap((record) => {
    const tab = record.indexOf('\t');
    const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/);
    const path = record.slice(tab + 1);
    // Regular files only: links and submodules are never prepared.
    return type === 'blob' && (mode === '100644' || mode === '100755') && languageGroupOf(path) !== null
      && !repository.exclude.some((prefix) => path.startsWith(prefix)) && eligiblePath(path, Number(size))
      ? [{ path, oid: oid! }] : [];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const batch = await gitWithInput(['-C', mirror, 'cat-file', '--batch'], entries.map((entry) => `${entry.oid}\n`).join(''));
  const files: { path: string; bytes: Buffer }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const newline = batch.indexOf(10, offset);
    const size = Number(batch.toString('utf8', offset, newline).split(' ')[2]);
    files.push({ path: entry.path, bytes: batch.subarray(newline + 1, newline + 1 + size) });
    offset = newline + 1 + size + 1;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Heuristic declarations

export type DeclarationKind = 'function' | 'method' | 'class' | 'struct' | 'enum' | 'trait' | 'impl'
  | 'interface' | 'type' | 'record' | 'mod' | 'module' | 'namespace' | 'object' | 'union' | 'extension' | 'protocol';

export type Declaration = {
  readonly kind: DeclarationKind;
  readonly name: string;
  /** The line holding the declaration keyword, not its leading comments or attributes. */
  readonly startLine: number;
  readonly endLine: number;
};

const CALLABLE_KINDS: ReadonlySet<DeclarationKind> = new Set(['function', 'method']);
export const isCallable = (declaration: Declaration): boolean => CALLABLE_KINDS.has(declaration.kind);

type Rule = {
  readonly pattern: RegExp;
  readonly kind: DeclarationKind | ((match: RegExpExecArray, indented: boolean) => DeclarationKind | null);
  /** Capture group holding the name; the last group by default. */
  readonly name?: number;
};

const ID = '[A-Za-z_$][\\w$]*';
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'super', 'this', 'foreach', 'using', 'lock', 'fixed', 'sizeof', 'elseif', 'match', 'when', 'guard', 'defer', 'select', 'synchronized', 'constructor']);
const method = (indexOfName: number) => (match: RegExpExecArray): DeclarationKind | null => NOT_METHODS.has(match[indexOfName]!) ? null : 'method';
const typeRule = (keywords: string, prefix: string): Rule => ({
  pattern: new RegExp(`^${prefix}(${keywords})\\s+(${ID})`), kind: (match) => match[1] as DeclarationKind,
});
const JS_MODIFIERS = '(?:(?:export|default|declare|abstract|async)\\s+)*';
const JAVA_MODIFIERS = '(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp|default|synchronized|native|internal|override|virtual|async|extern|unsafe|partial|readonly|new|open|inline|suspend|operator|infix|tailrec|external|data|value|inner|enum|annotation|companion|lateinit|actual|expect|const|fileprivate|mutating|nonmutating|convenience|required|dynamic|final|class|indirect)\\s+)*';

/** Declaration-line patterns per group: deliberately simple, comparable across languages and versions. */
const RULES: Readonly<Record<string, readonly Rule[]>> = {
  typescript: [
    { pattern: new RegExp(`^${JS_MODIFIERS}function\\s*\\*?\\s*(${ID})`), kind: 'function' },
    typeRule('class|interface|enum', JS_MODIFIERS),
    { pattern: new RegExp(`^${JS_MODIFIERS}type\\s+(${ID})\\s*(?:<.*>)?\\s*=`), kind: 'type' },
    { pattern: new RegExp(`^${JS_MODIFIERS}(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)?\\s*(?::[^=]*)?=>|${ID}\\s*=>)`), kind: 'function' },
    { pattern: new RegExp(`^(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*\\*?(${ID})\\s*(?:<[^>]*>)?\\s*\\([^;]*\\{\\s*$`), kind: (match, indented) => indented ? method(1)(match) : null },
  ],
  python: [
    { pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
    { pattern: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
  ],
  java: [
    typeRule('class|interface|enum|record', JAVA_MODIFIERS),
    { pattern: /^@interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { pattern: new RegExp(`^${JAVA_MODIFIERS}(?:<[^>]*>\\s*)?(?:[\\w.$<>\\[\\],?]+(?:\\s*<[^()]*>)?\\s+)?(${ID})\\s*\\([^;]*$`), kind: (match, indented) => indented ? method(1)(match) : null },
  ],
  go: [
    { pattern: /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, kind: 'method' },
    { pattern: /^func\s+([A-Za-z_]\w*)/, kind: 'function' },
    { pattern: /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/, kind: (match) => match[2] === 'struct' ? 'struct' : 'interface', name: 1 },
    { pattern: /^type\s+([A-Za-z_]\w*)/, kind: 'type' },
  ],
  rust: [
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+([A-Za-z_]\w*)/, kind: (_, indented) => indented ? 'method' : 'function' },
    { pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(struct|enum|trait|union|mod|type)\s+([A-Za-z_]\w*)/, kind: (match) => match[1] as DeclarationKind },
    { pattern: /^(?:unsafe\s+)?impl\b(?:\s*<[^>]*(?:<[^>]*>[^>]*)*>)?\s+(?:[^{]*?\bfor\s+)?([A-Za-z_][\w:]*)/, kind: 'impl' },
  ],
  c: [
    // Functions first: `struct tag *make(void) {` is a function returning a struct pointer.
    { pattern: new RegExp(`^(?:(?:static|inline|extern|const|unsigned|signed|struct|enum|volatile|__inline|[A-Z_]+)\\s+)*[\\w*]+[\\s*]+\\**(${ID})\\s*\\([^;]*$`), kind: (match) => NOT_METHODS.has(match[1]!) ? null : 'function' },
    typeRule('struct|union|enum', '(?:typedef\\s+)?'),
  ],
  cpp: [
    typeRule('class|struct|union|enum|namespace', '(?:template\\s*<.*>\\s*)?(?:typedef\\s+)?(?:enum\\s+)?'),
    { pattern: new RegExp(`^(?:template\\s*<.*>\\s*)?(?:(?:static|inline|virtual|explicit|constexpr|consteval|extern|const|unsigned|signed|friend|FMT_[A-Z_]+|[A-Z_]+)\\s+)*(?:[\\w:<>,*&]+[\\s*&]+)?\\**((?:${ID}::)*~?${ID})\\s*\\([^;]*$`), kind: (match, indented) => NOT_METHODS.has(match[1]!) ? null : indented || match[1]!.includes('::') ? 'method' : 'function' },
  ],
  csharp: [
    typeRule('class|struct|interface|enum|record|namespace', JAVA_MODIFIERS),
    { pattern: new RegExp(`^${JAVA_MODIFIERS}(?:[\\w.<>\\[\\],?]+(?:\\s*<[^()]*>)?\\s+)?(${ID})\\s*(?:<[^>]*>)?\\s*\\([^;]*$`), kind: (match, indented) => indented ? method(1)(match) : null },
  ],
  php: [
    typeRule('class|interface|trait|enum', '(?:(?:abstract|final|readonly)\\s+)*'),
    { pattern: /^(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/, kind: (_, indented) => indented ? 'method' : 'function' },
  ],
  kotlin: [
    { pattern: new RegExp(`^${JAVA_MODIFIERS}(class|interface|object)\\s+(${ID})`), kind: (match) => match[1] as DeclarationKind },
    { pattern: new RegExp(`^${JAVA_MODIFIERS}fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.<>?]+\\.)?(${ID})`), kind: (_, indented) => indented ? 'method' : 'function' },
  ],
  swift: [
    { pattern: new RegExp(`^${JAVA_MODIFIERS}(class|struct|enum|protocol|extension)\\s+(${ID})`), kind: (match) => match[1] as DeclarationKind },
    { pattern: new RegExp(`^${JAVA_MODIFIERS}func\\s+(${ID})`), kind: (_, indented) => indented ? 'method' : 'function' },
  ],
  ruby: [
    { pattern: /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: (_, indented) => indented ? 'method' : 'function' },
    { pattern: /^(class|module)\s+([A-Z]\w*(?:::\w+)*)/, kind: (match) => match[1] === 'class' ? 'class' : 'module' },
  ],
};
const rulesOf = (group: LanguageGroup): readonly Rule[] => RULES[group.id === 'javascript' ? 'typescript' : group.id] ?? [];

const indentOf = (line: string): number => {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
};
const isBlank = (line: string): boolean => line.trim() === '';

function matchDeclaration(group: LanguageGroup, line: string): { kind: DeclarationKind; name: string } | null {
  const trimmed = line.trim();
  for (const rule of rulesOf(group)) {
    const match = rule.pattern.exec(trimmed);
    if (match === null) continue;
    const kind = typeof rule.kind === 'function' ? rule.kind(match, indentOf(line) > 0) : rule.kind;
    if (kind === null) continue;
    return { kind, name: match[rule.name ?? match.length - 1]! };
  }
  return null;
}

/**
 * Last line of a brace-delimited declaration starting at `start` (0-based), or `start`
 * when it has no body. Strings and comments are skipped approximately.
 */
function braceEnd(group: LanguageGroup, lines: readonly string[], start: number): number {
  let depth = 0;
  let parens = 0;
  let opened = false;
  let block = false;
  const hashComments = group.id === 'php';
  const startIndent = indentOf(lines[start]!);
  for (let row = start; row < lines.length && row < start + 20_000; row += 1) {
    const line = lines[row]!;
    if (!opened && row > start && parens === 0 && !isBlank(line) && indentOf(line) <= startIndent && !line.trim().startsWith('{')) return row - 1;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      if (block) {
        if (char === '*' && line[index + 1] === '/') { block = false; index += 1; }
        continue;
      }
      if (char === '/' && line[index + 1] === '/') break;
      if (hashComments && char === '#' && line[index + 1] !== '[') break;
      if (char === '/' && line[index + 1] === '*') { block = true; index += 1; continue; }
      if (char === '"' || char === '`' || (char === '\'' && (group.id !== 'rust' || /^'(?:\\.[^']*|[^\\'])'/.test(line.slice(index))))) {
        index += 1;
        while (index < line.length && line[index] !== char) index += line[index] === '\\' ? 2 : 1;
        continue;
      }
      if (char === '(') parens += 1;
      else if (char === ')') parens = Math.max(0, parens - 1);
      else if (char === '{') { depth += 1; opened = true; }
      else if (char === '}') {
        depth -= 1;
        if (opened && depth <= 0) return row;
      } else if (char === ';' && !opened && parens === 0) return row;
    }
    if (!opened && row - start > 20) return start;
  }
  return opened ? lines.length - 1 : start;
}

/** Last line of an indentation-delimited (Python) block whose header starts at `start`. */
function indentationEnd(lines: readonly string[], start: number): number {
  const base = indentOf(lines[start]!);
  let last = start;
  let quote: string | null = null;
  for (let row = start; row < lines.length; row += 1) {
    const line = lines[row]!;
    if (quote === null && row > start && !isBlank(line) && indentOf(line) <= base && !/^\s*[)\]}]/.test(line)) break;
    if (!isBlank(line)) last = row;
    for (const match of line.matchAll(/"""|'''/g)) {
      if (quote === null) quote = match[0];
      else if (quote === match[0]) quote = null;
    }
  }
  return last;
}

/** Last line of a Ruby `def`/`class`/`module`: the `end` at its own indentation. */
function endKeywordEnd(lines: readonly string[], start: number): number {
  const header = lines[start]!;
  if (/\bend\s*$/.test(header) || /^\s*def\s+[^(]*(?:\([^)]*\))?\s*=/.test(header)) return start;
  const base = indentOf(header);
  for (let row = start + 1; row < lines.length; row += 1) {
    const line = lines[row]!;
    if (!isBlank(line) && indentOf(line) <= base) return line.trim().startsWith('end') ? row : row - 1;
  }
  return lines.length - 1;
}

/** Declarations of one file by line patterns and delimiter matching; an estimate, stable across chunker versions. */
export function heuristicDeclarations(group: LanguageGroup, text: string): Declaration[] {
  if (group.delimiting === 'none') return [];
  const lines = text.split(/\r?\n/);
  const declarations: Declaration[] = [];
  const classIndents: number[] = [];
  let quote: string | null = null;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]!;
    if (group.delimiting === 'indentation') {
      const inString = quote !== null;
      for (const match of line.matchAll(/"""|'''/g)) {
        if (quote === null) quote = match[0];
        else if (quote === match[0]) quote = null;
      }
      if (inString) continue;
      while (classIndents.length > 0 && !isBlank(line) && indentOf(line) <= classIndents.at(-1)!) classIndents.pop();
    }
    const found = matchDeclaration(group, line);
    if (found === null) continue;
    let kind = found.kind;
    if (group.delimiting === 'indentation') {
      if (kind === 'function' && classIndents.length > 0) kind = 'method';
      if (kind === 'class') classIndents.push(indentOf(line));
    }
    const endRow = group.delimiting === 'braces' ? braceEnd(group, lines, row)
      : group.delimiting === 'indentation' ? indentationEnd(lines, row) : endKeywordEnd(lines, row);
    declarations.push({ kind, name: found.name, startLine: row + 1, endLine: Math.max(row, endRow) + 1 });
  }
  return declarations;
}

// ---------------------------------------------------------------------------
// Fragment metrics

/** Spec 2.2: the first non-blank line is indented deeper than the fragment's least-indented line. */
export function startsMidBlock(text: string): boolean {
  const indents = text.split(/\r?\n/).filter((line) => !isBlank(line)).map(indentOf);
  return indents.length > 0 && indents[0]! > Math.min(...indents);
}

const ATTRIBUTE_OPENERS: Readonly<Record<string, RegExp>> = {
  rust: /^#!?\[/, php: /^#\[/, csharp: /^\[(?!\])/,
  java: /^@(?!interface\b)[A-Za-z_][\w.]*/, kotlin: /^@(?:[a-z]+:)?[A-Za-z_][\w.]*/, swift: /^@[A-Za-z_]\w*/,
  python: /^@[A-Za-z_][\w.]*/, typescript: /^@[A-Za-z_$][\w$.]*/, javascript: /^@[A-Za-z_$][\w$.]*/,
};

/** Bracket balance of `[`/`(` on a line, ignoring string contents. */
function bracketBalance(line: string): number {
  let balance = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"' || char === '\'') {
      index += 1;
      while (index < line.length && line[index] !== char) index += line[index] === '\\' ? 2 : 1;
    } else if (char === '[' || char === '(') balance += 1;
    else if (char === ']' || char === ')') balance -= 1;
  }
  return balance;
}

/**
 * Whether a fragment ends on an attribute, annotation or decorator line, cut from the
 * item after it. A line is an attribute line when it holds only attributes, or
 * continues one that opened earlier in the fragment.
 */
export function endsOnDetachedAttribute(group: LanguageGroup, fragmentText: string, lastNonBlankLineOfFile: number, fragmentEndLine: number): boolean {
  const opener = ATTRIBUTE_OPENERS[group.id];
  if (opener === undefined || fragmentEndLine >= lastNonBlankLineOfFile) return false;
  let open = 0;
  let lastIsAttribute = false;
  for (const line of fragmentText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (open > 0) {
      open += bracketBalance(trimmed);
      lastIsAttribute = true;
      continue;
    }
    const match = opener.exec(trimmed);
    if (match === null) { lastIsAttribute = false; continue; }
    const balance = bracketBalance(trimmed);
    if (balance > 0) { open = balance; lastIsAttribute = true; continue; }
    // Single-line: only attributes (and a trailing comment) on the line.
    const rest = group.id === 'rust' || group.id === 'php' || group.id === 'csharp'
      ? trimmed.replace(/^(?:#!?)?\[.*\]/, '') : trimmed.replace(/^(?:@[\w.:$]+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?\s*)+/, '');
    lastIsAttribute = /^\s*(?:\/\/.*|#.*)?$/.test(rest);
  }
  return lastIsAttribute;
}

/** The symbol a `kind:name` label names, without kind or qualifiers. */
export function labelledSymbol(label: string | null | undefined): string | null {
  if (label == null) return null;
  const colon = label.indexOf(':');
  const name = (colon < 0 ? label : label.slice(colon + 1)).split(/[\s(<>]/)[0]!;
  return name.split(/::|\./).at(-1) ?? name;
}

/** Counters for one group; ratios are derived in `summarize`. */
export type GroupCounters = {
  files: number; lines: number; nonBlankLines: number; fragments: number; labelled: number; small: number; midBlock: number;
  detachedAttributes: number; declarations: number; declarationsHidden: number; callables: number; splitCallables: number;
  splitCallablesWithDeclaration: number; continuations: number; continuationsUnlabelled: number;
  parseFallbackFiles: number; parseFallbackLines: number; syntaxFiles: number;
  chunkingMs: number; uncoveredNonBlankLines: number;
};

export const emptyCounters = (): GroupCounters => ({
  files: 0, lines: 0, nonBlankLines: 0, fragments: 0, labelled: 0, small: 0, midBlock: 0, detachedAttributes: 0,
  declarations: 0, declarationsHidden: 0, callables: 0, splitCallables: 0, splitCallablesWithDeclaration: 0,
  continuations: 0, continuationsUnlabelled: 0, parseFallbackFiles: 0, parseFallbackLines: 0, syntaxFiles: 0,
  chunkingMs: 0, uncoveredNonBlankLines: 0,
});

/** Add one chunked file to its group's counters. */
export function measureFile(group: LanguageGroup, snapshot: SourceSnapshot, result: Extract<ChunkResult, { kind: 'fragments' }>, chunkingMs: number, counters: GroupCounters): void {
  counters.files += 1;
  counters.lines += snapshot.lineCount;
  counters.chunkingMs += chunkingMs;
  let lastNonBlank = 0;
  for (let line = 1; line <= snapshot.lineCount; line += 1) {
    if (!snapshot.isBlankLine(line)) { counters.nonBlankLines += 1; lastNonBlank = line; }
  }
  const fragments = result.fragments;
  if (result.strategy === 'syntax' || result.fallback !== null) counters.syntaxFiles += 1;
  if (result.fallback !== null) {
    counters.parseFallbackFiles += 1;
    // A partially recovered file does not say which of its windows are recovered, so count the whole file.
    counters.parseFallbackLines += snapshot.lineCount;
  }
  counters.uncoveredNonBlankLines += uncoveredNonBlankLines(snapshot, fragments).length;
  for (const fragment of fragments) {
    counters.fragments += 1;
    if (fragment.label != null) counters.labelled += 1;
    if (fragment.endLine - fragment.startLine + 1 <= 3) counters.small += 1;
    if (startsMidBlock(fragment.text)) counters.midBlock += 1;
    if (endsOnDetachedAttribute(group, fragment.text, lastNonBlank, fragment.endLine)) counters.detachedAttributes += 1;
  }
  measureDeclarations(heuristicDeclarations(group, snapshot.text), fragments, counters);
}

const DECLARATION_KINDS_FOR_HIDING: ReadonlySet<DeclarationKind> = new Set([
  'function', 'method', 'class', 'struct', 'enum', 'trait', 'impl', 'interface', 'type', 'record', 'mod',
]);

/** Declarations hidden, split callables, back-references and continuations of one file. */
export function measureDeclarations(declarations: readonly Declaration[], fragments: readonly PreparedFragment[], counters: GroupCounters): void {
  const continuations = new Map<string, PreparedFragment>();
  for (const declaration of declarations) {
    const containing = fragments.filter((fragment) => fragment.startLine <= declaration.startLine && fragment.endLine >= declaration.startLine);
    if (DECLARATION_KINDS_FOR_HIDING.has(declaration.kind)) {
      counters.declarations += 1;
      if (!containing.some((fragment) => labelledSymbol(fragment.label) === declaration.name)) counters.declarationsHidden += 1;
    }
    if (!isCallable(declaration)) continue;
    counters.callables += 1;
    const overlapping = fragments.filter((fragment) => fragment.startLine <= declaration.endLine && fragment.endLine >= declaration.startLine);
    const whole = overlapping.some((fragment) => fragment.startLine <= declaration.startLine && fragment.endLine >= declaration.endLine);
    if (whole || overlapping.length < 2) continue;
    counters.splitCallables += 1;
    if (overlapping.every((fragment) => fragment.declaration != null
      && fragment.declaration.startLine <= declaration.startLine && fragment.declaration.endLine >= declaration.startLine)) {
      counters.splitCallablesWithDeclaration += 1;
    }
    for (const fragment of overlapping) {
      if (fragment.startLine > declaration.startLine) continuations.set(fragment.id, fragment);
    }
  }
  for (const fragment of continuations.values()) {
    counters.continuations += 1;
    if (fragment.label == null) counters.continuationsUnlabelled += 1;
  }
}

// Unrounded, so a rate just over a gate limit never rounds down to it.
const ratio = (part: number, whole: number): number | null => whole === 0 ? null : part / whole;

/** The per-group row of the report. Shares are fractions in [0, 1], null when undefined. */
export function summarize(counters: GroupCounters) {
  return {
    files: counters.files, lines: counters.lines, fragments: counters.fragments,
    profiled: counters.syntaxFiles * 2 > counters.files,
    labelledShare: ratio(counters.labelled, counters.fragments),
    smallFragmentShare: ratio(counters.small, counters.fragments),
    midBlockShare: ratio(counters.midBlock, counters.fragments),
    detachedAttributeFragments: counters.detachedAttributes,
    declarations: counters.declarations,
    declarationsHiddenShare: ratio(counters.declarationsHidden, counters.declarations),
    callables: counters.callables,
    splitCallables: counters.splitCallables,
    splitCallablesWithDeclarationShare: ratio(counters.splitCallablesWithDeclaration, counters.splitCallables),
    continuations: counters.continuations,
    continuationsUnlabelledShare: ratio(counters.continuationsUnlabelled, counters.continuations),
    parseFallbackFiles: counters.parseFallbackFiles,
    parseFallbackFileShare: ratio(counters.parseFallbackFiles, counters.files),
    parseFallbackLineShare: ratio(counters.parseFallbackLines, counters.lines),
    chunkingMsPer1000Lines: counters.lines === 0 ? null : Number((counters.chunkingMs * 1000 / counters.lines).toFixed(2)),
    uncoveredNonBlankLines: counters.uncoveredNonBlankLines,
  };
}
export type GroupSummary = ReturnType<typeof summarize>;

// ---------------------------------------------------------------------------
// Gates (spec 9.1)

export type GateResult = { readonly gate: string; readonly value: number | null; readonly limit: string; readonly passed: boolean };

const LINE_SHARE_FALLBACK_GROUPS = new Set(['c', 'cpp']);

/**
 * Spec 9.1 gates. A profiled language gets the full set; a language left on line
 * windows only the coverage gate and, against a baseline row, half its mid-block share.
 */
export function gatesFor(group: string, row: GroupSummary, baseline?: GroupSummary): GateResult[] {
  const at = (gate: string, value: number | null, limit: string, passed: boolean): GateResult => ({ gate, value, limit, passed });
  const gates = [at('uncoveredNonBlankLines', row.uncoveredNonBlankLines, '= 0', row.uncoveredNonBlankLines === 0)];
  if (!row.profiled) {
    if (baseline?.midBlockShare != null) {
      const limit = baseline.midBlockShare / 2;
      gates.push(at('midBlockShare', row.midBlockShare, `<= ${limit.toFixed(4)} (half of baseline)`, (row.midBlockShare ?? 0) <= limit));
    }
    return gates;
  }
  gates.push(
    at('detachedAttributeFragments', row.detachedAttributeFragments, '= 0', row.detachedAttributeFragments === 0),
    at('splitCallablesWithDeclarationShare', row.splitCallablesWithDeclarationShare, '= 1', (row.splitCallablesWithDeclarationShare ?? 1) === 1),
    at('midBlockShare', row.midBlockShare, '<= 0.15', (row.midBlockShare ?? 0) <= 0.15),
    at('continuationsUnlabelledShare', row.continuationsUnlabelledShare, '= 0', (row.continuationsUnlabelledShare ?? 0) === 0),
    at('smallFragmentShare', row.smallFragmentShare, '<= 0.03', (row.smallFragmentShare ?? 0) <= 0.03),
    LINE_SHARE_FALLBACK_GROUPS.has(group)
      ? at('parseFallbackLineShare', row.parseFallbackLineShare, '<= 0.10', (row.parseFallbackLineShare ?? 0) <= 0.1)
      : at('parseFallbackFileShare', row.parseFallbackFileShare, '<= 0.01', (row.parseFallbackFileShare ?? 0) <= 0.01),
  );
  return gates;
}
