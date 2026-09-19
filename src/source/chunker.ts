/**
 * Syntax-aware fragment preparation for JavaScript and TypeScript (JG-015).
 *
 * The line-window chunker (JG-012, `line-windows.ts`) stays the reference and the
 * fallback; this module only improves *where* JS/TS fragments begin and end. It
 * produces the same fragment shape, so nothing downstream has to know which chunker
 * ran. A file this module cannot read lexically falls back to line windows with an
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
import { scanJavaScriptBoundaries } from './javascript-boundaries.ts';
import type { Boundary } from './javascript-boundaries.ts';
import { DEFAULT_WINDOW_LIMITS, LINE_WINDOW_CHUNKER_VERSION, lineWindows } from './line-windows.ts';
import type { FragmentWindow, UnsupportedLongLine, WindowLimits } from './line-windows.ts';
import type { SourceSnapshot } from './snapshot.ts';

export { DEFAULT_WINDOW_LIMITS, LINE_WINDOW_CHUNKER_VERSION };
export type { WindowLimits };

/** Bumped when syntax boundaries change; part of evaluation identity (JG-018). */
export const SYNTAX_CHUNKER_VERSION = 'jevgrep-syntax-1';

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
};

export type ChunkFallback = 'parse_failure';

export type ChunkResult =
  | {
    readonly kind: 'fragments';
    readonly strategy: 'syntax' | 'line-window';
    /** Why a JS/TS file used windows instead of syntax units, when it did. */
    readonly fallback: ChunkFallback | null;
    readonly fragments: readonly PreparedFragment[];
  }
  | UnsupportedLongLine;

const SYNTAX_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** True for the eight JS/TS extensions the syntax chunker attempts. */
export function usesSyntaxChunking(path: string): boolean {
  return SYNTAX_EXTENSIONS.has(extensionOf(path));
}

type LineRange = { readonly startLine: number; readonly endLine: number; readonly label: string | null };

function fragmentOf(snapshot: SourceSnapshot, range: LineRange): PreparedFragment {
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
    // over-estimating is the safe direction.
    tokenCount: countReferenceTokens(slice.text),
    chunker: SYNTAX_CHUNKER_VERSION,
    classification: 'syntax-range',
    label: range.label,
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
 * ones JG-012 defines.
 */
function windowsOfRange(
  snapshot: SourceSnapshot,
  range: LineRange,
  limits: WindowLimits,
): PreparedFragment[] | UnsupportedLongLine {
  const fragments: PreparedFragment[] = [];
  let cursor = range.startLine;

  while (cursor <= range.endLine) {
    if (snapshot.lineTokens(cursor) > limits.maxTokens || snapshot.rangeBytes(cursor, cursor) > limits.maxBytes) {
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
      fragments.push(fragmentOf(snapshot, {
        startLine: cursor, endLine: end, label: cursor === range.startLine ? range.label : null,
      }));
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
  let label = boundaries.find((boundary) => boundary.line === startLine)?.label ?? null;
  for (const start of starts) {
    if (start.line > current) {
      units.push({ startLine: current, endLine: start.line - 1, label });
      current = start.line;
      label = start.label;
    }
  }
  units.push({ startLine: current, endLine, label });
  return units;
}

/**
 * Pack consecutive units into fragments.
 *
 * Neighbouring small units (imports, one-line exports, a short constant) are grouped
 * up to the target size; a unit already larger than the hard limits is refined by
 * deeper syntax boundaries when they exist, and by line windows otherwise.
 */
function packUnits(
  snapshot: SourceSnapshot,
  units: readonly LineRange[],
  limits: WindowLimits,
  refine: (unit: LineRange) => PreparedFragment[] | UnsupportedLongLine | null,
): PreparedFragment[] | UnsupportedLongLine {
  const fragments: PreparedFragment[] = [];
  let pending: LineRange | null = null;

  const flush = (): void => {
    if (pending !== null && !isBlankRange(snapshot, pending.startLine, pending.endLine)) {
      fragments.push(fragmentOf(snapshot, pending));
    }
    pending = null;
  };

  for (const unit of units) {
    const tokens = snapshot.rangeTokens(unit.startLine, unit.endLine);
    const bytes = snapshot.rangeBytes(unit.startLine, unit.endLine);
    const lines = unit.endLine - unit.startLine + 1;

    if (tokens > limits.maxTokens || bytes > limits.maxBytes || lines > limits.maxLines) {
      flush();
      const refined = refine(unit) ?? windowsOfRange(snapshot, unit, limits);
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
      pending = { startLine: pending.startLine, endLine: unit.endLine, label: pending.label ?? unit.label };
      continue;
    }
    flush();
    pending = unit;
  }
  flush();
  return fragments;
}

/** Whole-file line windows, produced by the JG-012 chunker and relabelled for this shape. */
function fallbackWindows(snapshot: SourceSnapshot, limits: WindowLimits): ChunkResult {
  const result = lineWindows(
    { path: snapshot.relativePath, text: snapshot.text, sha256: snapshot.sha256 },
    limits,
  );
  if (result.kind === 'unsupported-long-line') {
    return result;
  }
  return { kind: 'fragments', strategy: 'line-window', fallback: null, fragments: result.windows };
}

/**
 * Prepare every fragment of one snapshot.
 *
 * Non-JS/TS text uses JG-012 directly. JS/TS text is scanned for statement
 * boundaries; if the scanner refuses the file, the same JG-012 windows are returned
 * with `fallback: 'parse_failure'` so the caller can report it.
 */
export function chunkSnapshot(
  snapshot: SourceSnapshot,
  limits: WindowLimits = DEFAULT_WINDOW_LIMITS,
): ChunkResult {
  if (!usesSyntaxChunking(snapshot.relativePath)) {
    return fallbackWindows(snapshot, limits);
  }

  const scan = scanJavaScriptBoundaries(
    snapshot.text,
    (offset) => snapshot.lineOfUtf16(offset),
    { jsx: JSX_EXTENSIONS.has(extensionOf(snapshot.relativePath)) },
  );
  if (!scan.ok) {
    const windows = fallbackWindows(snapshot, limits);
    return windows.kind === 'unsupported-long-line'
      ? windows
      : { ...windows, fallback: 'parse_failure' };
  }

  const { boundaries } = scan;
  const maxRefineDepth = 2;
  const refineAt = (depth: number) => (unit: LineRange): PreparedFragment[] | UnsupportedLongLine | null => {
    if (depth > maxRefineDepth) {
      return null;
    }
    const inner = unitsFromBoundaries(boundaries, depth, unit.startLine, unit.endLine);
    if (inner.length <= 1) {
      return refineAt(depth + 1)(unit);
    }
    return packUnits(snapshot, inner, limits, refineAt(depth + 1));
  };

  const units = unitsFromBoundaries(boundaries, 0, 1, snapshot.lineCount);
  const packed = packUnits(snapshot, units, limits, refineAt(1));
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
