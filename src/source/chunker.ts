/**
 * Syntax-aware fragment preparation for JavaScript, TypeScript, Python and Java (JG-015).
 *
 * The line-window chunker (JG-012, `line-windows.ts`) stays the reference and the
 * fallback; this module only improves *where* source fragments begin and end. It
 * produces the same fragment shape, so nothing downstream has to know which chunker
 * ran. A file this module cannot parse falls back to line windows with an
 * explicit reason instead of disappearing (specification section 5.4).
 *
 * Guarantees kept here:
 * - every line of the file belongs to at least one fragment, because the units are a
 *   partition of the file's lines and packing only groups or splits contiguous runs;
 * - fragments are exact snapshot slices; no generator or printer is involved;
 * - identical input and limits always produce identical fragments, in order;
 * - nothing from the repository is imported, executed, compiled or type-checked.
 */
import { countReferenceTokens } from '../response/token-counter.ts';
import { measureSync } from '../profiling.ts';
import { parseJavaBoundaries } from './java-boundaries.ts';
import { planJavaScriptRanges } from './javascript-chunker.ts';
import type { JavaScriptContextPolicy } from './javascript-chunker.ts';
import type { ParseOutcome } from './javascript-boundaries.ts';
import { parsePythonBoundaries } from './python-boundaries.ts';
import type { Boundary } from './javascript-boundaries.ts';
import { DEFAULT_WINDOW_LIMITS, LINE_WINDOW_CHUNKER_VERSION, lineWindowsOf } from './line-windows.ts';
import type { FragmentWindow, UnsupportedLongLine, WindowLimits } from './line-windows.ts';
import type { SourceSnapshot } from './snapshot.ts';
import { TREE_SITTER_GRAMMARS, parseTreeSitterBoundaries } from './tree-sitter-boundaries.ts';

export { DEFAULT_WINDOW_LIMITS, LINE_WINDOW_CHUNKER_VERSION };
export type { WindowLimits };

export type SyntaxLanguage = 'javascript' | 'python' | 'java' | 'go' | 'rust';

/** Bumped per language when its syntax boundaries change; part of evaluation identity (JG-018). */
export const SYNTAX_CHUNKER_VERSIONS: Readonly<Record<SyntaxLanguage, string>> = {
  javascript: 'jevgrep-typescript-6.0.2-4',
  python: 'jevgrep-python-scan-2',
  java: 'jevgrep-java-scan-3',
  go: `jevgrep-${TREE_SITTER_GRAMMARS.go}-3`,
  rust: `jevgrep-${TREE_SITTER_GRAMMARS.rust}-3`,
};

export const SYNTAX_CHUNKER_VERSION = SYNTAX_CHUNKER_VERSIONS.javascript;

/**
 * A prepared fragment from either chunker.
 *
 * `classification` widens JG-012's literal so a structural range can say so; `label`
 * is an optional structural hint (`function:handle`) used as request metadata and in
 * local diagnostics, never as returned evidence.
 */
export type PreparedFragment = Omit<FragmentWindow, 'classification'> & {
  readonly classification: 'line-window' | 'syntax-range';
  readonly label?: string | null;
  /** The innermost declaration this fragment was cut from, when a declaration became several fragments. */
  readonly declaration?: DeclarationRange | null;
};

export type DeclarationRange = { readonly startLine: number; readonly endLine: number };

export type ChunkFallback = 'parse_failure';

export type ChunkResult =
  | {
    readonly kind: 'fragments';
    readonly strategy: 'syntax' | 'line-window';
    /** Why a syntax-chunked file used windows instead of syntax units, when it did. */
    readonly fallback: ChunkFallback | null;
    readonly fragments: readonly PreparedFragment[];
  }
  | UnsupportedLongLine;

const SYNTAX_LANGUAGES: ReadonlyMap<string, SyntaxLanguage> = new Map([
  ...['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'].map((extension) => [extension, 'javascript'] as const),
  ['.py', 'python'],
  ['.pyi', 'python'],
  ['.java', 'java'],
  ['.go', 'go'],
  ['.rs', 'rust'],
]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** The language whose syntax boundaries are attempted for `path`, if any. */
export function syntaxLanguageOf(path: string): SyntaxLanguage | null {
  return SYNTAX_LANGUAGES.get(extensionOf(path)) ?? null;
}

/** True for the JS/TS, Python, Java, Go and Rust extensions the syntax chunker attempts. */
export function usesSyntaxChunking(path: string): boolean {
  return syntaxLanguageOf(path) !== null;
}

function parseBoundaries(language: Exclude<SyntaxLanguage, 'javascript'>, snapshot: SourceSnapshot): ParseOutcome {
  const lineOfOffset = (offset: number): number => snapshot.lineOfUtf16(offset);
  switch (language) {
    case 'python':
      return parsePythonBoundaries(snapshot.text, lineOfOffset);
    case 'java':
      return parseJavaBoundaries(snapshot.text, lineOfOffset);
    case 'go':
    case 'rust':
      return parseTreeSitterBoundaries(language, snapshot.text);
  }
}

/**
 * Everything besides content and limits that determines a path's fragments: its
 * extension (which selects the parser mode) and every chunker that may produce them,
 * including the line-window fallback of syntax chunking.
 */
export function chunkerIdentityFor(path: string): string {
  const extension = extensionOf(path);
  const language = syntaxLanguageOf(path);
  return language === null
    ? `${extension}|${LINE_WINDOW_CHUNKER_VERSION}`
    : `${extension}|${SYNTAX_CHUNKER_VERSIONS[language]}|${LINE_WINDOW_CHUNKER_VERSION}`;
}

type LineRange = {
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string | null;
  /** The range starts at a labelled boundary of its own depth, so it is a declaration. */
  readonly declares?: boolean;
  /** The declaration a range carrying a header holds, when it is not the range itself. */
  readonly holds?: DeclarationRange;
};

function fragmentOf(snapshot: SourceSnapshot, range: LineRange, chunker: string): PreparedFragment {
  const slice = snapshot.sliceLines(range.startLine, range.endLine);
  return {
    id: `${snapshot.relativePath}#L${String(range.startLine)}-L${String(range.endLine)}`,
    path: snapshot.relativePath,
    sha256: snapshot.sha256,
    startLine: range.startLine,
    endLine: range.endLine,
    byteStart: slice.startByte,
    byteEnd: slice.endByte,
    text: slice.text,
    byteCount: slice.byteLength,
    // Measured on the slice itself: summing line costs over-estimates a BPE counter,
    // whose merges cross line endings. The sums stay in the packing decisions, where
    // over-estimating is the safe direction. A one-line slice is exactly a cached line.
    tokenCount: range.startLine === range.endLine ? snapshot.lineTokens(range.startLine) : countReferenceTokens(slice.text),
    chunker,
    classification: 'syntax-range',
    label: range.label,
  };
}

/**
 * Record the declaration a fragment was cut from; a fragment holding the whole declaration was not cut from it.
 * The recorded range also covers the fragment, so returning it whole never drops lines the fragment had.
 */
function cutFrom(fragment: PreparedFragment, declaration: DeclarationRange | null): PreparedFragment {
  if (declaration === null || (fragment.startLine <= declaration.startLine && fragment.endLine >= declaration.endLine)) {
    return fragment;
  }
  return {
    ...fragment,
    declaration: {
      startLine: Math.min(fragment.startLine, declaration.startLine), endLine: Math.max(fragment.endLine, declaration.endLine),
    },
  };
}

function isBlankRange(snapshot: SourceSnapshot, startLine: number, endLine: number): boolean {
  for (let line = startLine; line <= endLine; line += 1) {
    if (!snapshot.isBlankLine(line)) {
      return false;
    }
  }
  return true;
}

/**
 * Split one range into windows under the active limits.
 *
 * JG-012 owns whole-file windowing; this range-level variant exists because an
 * oversized declaration must be split *inside* its own line range while keeping the
 * file's real line numbers and byte offsets. Limits and overlap semantics are the
 * ones JG-012 defines. Windows record `declaration`, the declaration enclosing the
 * range, or the range itself when it has none and is split.
 */
function windowsOfRange(
  snapshot: SourceSnapshot,
  range: LineRange,
  limits: WindowLimits,
  chunker: string,
  labelEveryWindow = false,
  declaration: DeclarationRange | null = null,
): PreparedFragment[] | UnsupportedLongLine {
  const fragments: PreparedFragment[] = [];
  let cursor = range.startLine;

  while (cursor <= range.endLine) {
    if (snapshot.rangeBytes(cursor, cursor) > limits.maxBytes || snapshot.lineTokens(cursor) > limits.maxTokens) {
      return {
        kind: 'unsupported-long-line', line: cursor, reason: 'unsupported_long_line',
        byteCount: snapshot.rangeBytes(cursor, cursor), tokenCount: snapshot.lineTokens(cursor),
      };
    }
    let end = cursor;
    while (end < range.endLine) {
      const nextLines = end + 2 - cursor;
      if (nextLines > limits.targetLines
        || snapshot.rangeTokens(cursor, end + 1) > limits.maxTokens
        || snapshot.rangeBytes(cursor, end + 1) > limits.maxBytes) {
        break;
      }
      end += 1;
    }
    if (!isBlankRange(snapshot, cursor, end)) {
      fragments.push(cutFrom(fragmentOf(snapshot, {
        startLine: cursor, endLine: end, label: labelEveryWindow || cursor === range.startLine ? range.label : null,
      }, chunker), declaration ?? range));
    }
    if (end >= range.endLine) {
      break;
    }
    const windowLines = end - cursor + 1;
    cursor = windowLines > limits.overlapLines ? end + 1 - limits.overlapLines : end + 1;
  }
  return fragments;
}

/** Turn boundary lines into a partition of `[startLine, endLine]`, so no line is dropped. */
function unitsFromBoundaries(
  boundaries: readonly Boundary[],
  depth: number,
  startLine: number,
  endLine: number,
): LineRange[] {
  const starts = boundaries
    .filter((boundary) => boundary.depth === depth && boundary.line > startLine && boundary.line <= endLine)
    .map((boundary) => ({ line: boundary.line, label: boundary.label }));

  const units: LineRange[] = [];
  let current = startLine;
  // The first unit inherits the label of an enclosing boundary on the same line, but only
  // a boundary of this depth makes it a declaration of its own.
  let label = boundaries.find((boundary) => boundary.line === startLine)?.label ?? null;
  let declares = boundaries.some((boundary) => boundary.line === startLine && boundary.depth === depth && boundary.label !== null);
  for (const start of starts) {
    if (start.line > current) {
      units.push({ startLine: current, endLine: start.line - 1, label, declares });
      current = start.line;
      label = start.label;
      declares = start.label !== null;
    }
  }
  units.push({ startLine: current, endLine, label, declares });
  return units;
}

/**
 * Pack consecutive units into fragments.
 *
 * Neighbouring small units (imports, one-line exports, a short constant) are grouped
 * up to the target size; a unit already larger than the hard limits is refined by
 * deeper syntax boundaries when they exist, and by line windows otherwise.
 *
 * `enclosing` is the declaration being split, recorded on every fragment. Units that
 * refine an oversized unit form continuations: with `firstUnitLabels`, a group is
 * labelled by its first unit only, never by a nested symbol it happens to contain.
 */
function packUnits(
  snapshot: SourceSnapshot,
  units: readonly LineRange[],
  limits: WindowLimits,
  chunker: string,
  refine: (unit: LineRange, declaration: DeclarationRange | null) => PreparedFragment[] | UnsupportedLongLine | null,
  enclosing: DeclarationRange | null,
  firstUnitLabels: boolean,
): PreparedFragment[] | UnsupportedLongLine {
  const fragments: PreparedFragment[] = [];
  let pending: LineRange | null = null;

  const flush = (): void => {
    if (pending !== null && !isBlankRange(snapshot, pending.startLine, pending.endLine)) {
      fragments.push(cutFrom(fragmentOf(snapshot, pending, chunker), enclosing));
    }
    pending = null;
  };

  for (const unit of units) {
    const tokens = snapshot.rangeTokens(unit.startLine, unit.endLine);
    const bytes = snapshot.rangeBytes(unit.startLine, unit.endLine);
    const lines = unit.endLine - unit.startLine + 1;

    if (tokens > limits.maxTokens || bytes > limits.maxBytes || lines > limits.maxLines) {
      flush();
      const declaration = unit.holds ?? (unit.declares === true ? unit : enclosing);
      const refined = refine(unit, declaration) ?? windowsOfRange(snapshot, unit, limits, chunker, false, declaration);
      if (!Array.isArray(refined)) {
        return refined as UnsupportedLongLine;
      }
      fragments.push(...refined);
      continue;
    }
    if (pending === null) {
      pending = unit;
      continue;
    }
    const mergedTokens = snapshot.rangeTokens(pending.startLine, unit.endLine);
    const mergedBytes = snapshot.rangeBytes(pending.startLine, unit.endLine);
    const mergedLines = unit.endLine - pending.startLine + 1;
    if (mergedTokens <= limits.targetTokens && mergedBytes <= limits.maxBytes && mergedLines <= limits.maxLines) {
      pending = {
        startLine: pending.startLine, endLine: unit.endLine, label: firstUnitLabels ? pending.label : pending.label ?? unit.label,
      };
      continue;
    }
    flush();
    pending = unit;
  }
  flush();
  return fragments;
}

/** Whole-file line windows, produced by the JG-012 chunker and relabelled for this shape. */
export function fallbackWindows(snapshot: SourceSnapshot, limits: WindowLimits): ChunkResult {
  const result = lineWindowsOf(
    { path: snapshot.relativePath, text: snapshot.text, sha256: snapshot.sha256 },
    snapshot,
    limits,
    countReferenceTokens,
  );
  if (result.kind === 'unsupported-long-line') {
    return result;
  }
  return { kind: 'fragments', strategy: 'line-window', fallback: null, fragments: result.windows };
}

/** The preparation seam: a cache identity per path and the chunker that matches it. */
export type SnapshotChunker = {
  readonly identity: (relativePath: string) => string;
  readonly chunk: (snapshot: SourceSnapshot, limits: WindowLimits) => ChunkResult;
};

export const DEFAULT_CHUNKER: SnapshotChunker = Object.freeze({
  identity: chunkerIdentityFor,
  chunk: (snapshot: SourceSnapshot, limits: WindowLimits) => chunkSnapshot(snapshot, limits),
});

export type ChunkOptions = {
  /**
   * JS/TS label policy, the E1 metadata variable. `local` (default) labels a range with the
   * symbol it starts; `enclosing` and `compact` add the enclosing chain and measured no better.
   */
  readonly javascriptContext?: JavaScriptContextPolicy;
};

/**
 * Prepare every fragment of one snapshot.
 *
 * Text in other languages uses JG-012 directly. JS/TS text is split recursively along
 * its syntax tree; Python, Java, Go and Rust text is parsed for statement boundaries. If the
 * parser refuses the file, the same JG-012 windows are returned with
 * `fallback: 'parse_failure'` so the caller can report it. A JS/TS file whose syntax
 * errors stay local keeps its structure elsewhere and also reports `parse_failure`.
 */
export function chunkSnapshot(
  snapshot: SourceSnapshot,
  limits: WindowLimits = DEFAULT_WINDOW_LIMITS,
  options: ChunkOptions = {},
): ChunkResult {
  // Every chunker rejects a line above the byte ceiling; find it before parsing or BPE work.
  // Blank-only files carry no fragment, so they never reach this refusal.
  const longLine = snapshot.isBlank() ? null : snapshot.firstLineOverBytes(limits.maxBytes);
  if (longLine !== null) {
    return {
      kind: 'unsupported-long-line', line: longLine, reason: 'unsupported_long_line',
      byteCount: snapshot.rangeBytes(longLine, longLine), tokenCount: null,
    };
  }
  const language = syntaxLanguageOf(snapshot.relativePath);
  if (language === null) {
    return fallbackWindows(snapshot, limits);
  }
  if (language === 'javascript') {
    return chunkJavaScript(snapshot, limits, options.javascriptContext ?? 'local');
  }

  const chunker = SYNTAX_CHUNKER_VERSIONS[language];
  const scan = measureSync('parsing', () => parseBoundaries(language, snapshot));
  if (!scan.ok) {
    return parseFailure(snapshot, limits);
  }
  return chunkWithBoundaries(snapshot, scan.boundaries, limits, chunker, language === 'java' ? JAVA_PACKING : {});
}

/** Java nests members in nested types at any depth, and a type or member header never stands alone. */
const JAVA_PACKING: BoundaryPacking = { maxRefineDepth: 'deepest', carryHeaders: true };

function parseFailure(snapshot: SourceSnapshot, limits: WindowLimits): ChunkResult {
  const windows = fallbackWindows(snapshot, limits);
  return windows.kind === 'unsupported-long-line' ? windows : { ...windows, fallback: 'parse_failure' };
}

function chunkJavaScript(snapshot: SourceSnapshot, limits: WindowLimits, context: JavaScriptContextPolicy): ChunkResult {
  const chunker = SYNTAX_CHUNKER_VERSIONS.javascript;
  const plan = measureSync('parsing', () => planJavaScriptRanges(snapshot, limits, context));
  if (!plan.ok) {
    return parseFailure(snapshot, limits);
  }
  const fragments: PreparedFragment[] = [];
  for (const range of plan.ranges) {
    if (range.windows || snapshot.rangeTokens(range.startLine, range.endLine) > limits.maxTokens
      || snapshot.rangeBytes(range.startLine, range.endLine) > limits.maxBytes
      || range.endLine - range.startLine + 1 > limits.maxLines) {
      const windows = windowsOfRange(snapshot, range, limits, chunker, range.labelEveryWindow, range.declaration);
      if (!Array.isArray(windows)) {
        return windows;
      }
      fragments.push(...windows);
    } else if (!isBlankRange(snapshot, range.startLine, range.endLine)) {
      fragments.push(cutFrom(fragmentOf(snapshot, range, chunker), range.declaration));
    }
  }
  return { kind: 'fragments', strategy: 'syntax', fallback: plan.recovered ? 'parse_failure' : null, fragments };
}

export type BoundaryPacking = {
  /** Deepest boundary depth used to refine an oversized unit: 2 by default, or every depth present. */
  readonly maxRefineDepth?: number | 'deepest';
  /**
   * Carry the head of a refined unit (`class Inner {`, a method signature) into the unit
   * that follows it, so a header is never a fragment of its own.
   */
  readonly carryHeaders?: boolean;
  /** Label a continuation with a nested symbol it contains, the policy of `jevgrep-typescript-6.0.2-2`. */
  readonly nestedContinuationLabels?: boolean;
};

/**
 * Depth-indexed boundary packing, used by the Python, Java, Go and Rust parsers and kept
 * as the previous JS/TS policy for the E1 comparison.
 */
export function chunkWithBoundaries(
  snapshot: SourceSnapshot,
  boundaries: readonly Boundary[],
  limits: WindowLimits,
  chunker: string,
  packing: BoundaryPacking = {},
): ChunkResult {
  const maxRefineDepth = packing.maxRefineDepth === 'deepest'
    ? boundaries.reduce((deepest, boundary) => Math.max(deepest, boundary.depth), 0)
    : packing.maxRefineDepth ?? 2;
  const nestedLabels = packing.nestedContinuationLabels === true;
  const fits = (startLine: number, endLine: number): boolean => snapshot.rangeTokens(startLine, endLine) <= limits.maxTokens
    && snapshot.rangeBytes(startLine, endLine) <= limits.maxBytes && endLine - startLine + 1 <= limits.maxLines;
  type Refine = (unit: LineRange, declaration: DeclarationRange | null) => PreparedFragment[] | UnsupportedLongLine | null;
  const refineAt = (depth: number): Refine => (unit, declaration) => {
    if (depth > maxRefineDepth) {
      return null;
    }
    let inner = unitsFromBoundaries(boundaries, depth, unit.startLine, unit.endLine);
    if (packing.carryHeaders === true && inner.length > 1) {
      const [head, next, ...rest] = inner as [LineRange, LineRange, ...LineRange[]];
      // A unit that fits on its own is never split just to take the header along.
      if (fits(head.startLine, next.endLine) || !fits(next.startLine, next.endLine)) {
        // The declaration is the unit the header was carried into; fragments holding the header still cover it.
        const holds = next.declares === true ? { startLine: next.startLine, endLine: next.endLine } : undefined;
        inner = [{
          startLine: head.startLine, endLine: next.endLine, label: head.label ?? next.label, declares: head.declares === true,
          ...(holds === undefined ? {} : { holds }),
        }, ...rest];
      }
    }
    if (inner.length <= 1) {
      const held = inner[0]?.holds ?? declaration;
      // When no deeper depth splits it, the line windows still record the declaration the header was carried into.
      return refineAt(depth + 1)(unit, held)
        ?? (held === declaration ? null : windowsOfRange(snapshot, unit, limits, chunker, false, held));
    }
    return packUnits(snapshot, inner, limits, chunker, refineAt(depth + 1), declaration, !nestedLabels);
  };

  const units = unitsFromBoundaries(boundaries, 0, 1, snapshot.lineCount);
  const packed = packUnits(snapshot, units, limits, chunker, refineAt(1), null, false);
  if (!Array.isArray(packed)) {
    return packed as UnsupportedLongLine;
  }
  return { kind: 'fragments', strategy: 'syntax', fallback: null, fragments: packed };
}

/** Non-blank lines covered by no fragment; the coverage invariant of R3 and R4. */
export function uncoveredNonBlankLines(
  snapshot: SourceSnapshot,
  fragments: readonly PreparedFragment[],
): number[] {
  const covered = new Uint8Array(snapshot.lineCount + 1);
  for (const fragment of fragments) {
    for (let line = fragment.startLine; line <= fragment.endLine; line += 1) {
      covered[line] = 1;
    }
  }
  const missing: number[] = [];
  for (let line = 1; line <= snapshot.lineCount; line += 1) {
    if (covered[line] !== 1 && !snapshot.isBlankLine(line)) {
      missing.push(line);
    }
  }
  return missing;
}
