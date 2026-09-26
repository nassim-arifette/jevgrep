/**
 * Line-window chunker (JG-012, specification 5.4, requirements R3 and R4).
 *
 * This is the fallback chunker: contiguous, line-aligned windows with bounded token,
 * byte and line limits and bounded overlap. It carries no file-system, scheduling or
 * provider behaviour - it is a pure function over one prepared snapshot, which is the
 * seam the plan asks the chunker to hide behind (`fragment(snapshot)`).
 *
 * The syntax chunker (JG-015) will produce structural ranges through the same output
 * shape; `classification` says which one produced a window.
 */
import { countReferenceTokens } from '../response/token-counter.ts';

/** The part of a source snapshot this chunker needs. */
export type SnapshotText = {
  /** Normalized relative path with POSIX separators. */
  readonly path: string;
  /** Decoded original text: newlines, whitespace, Unicode and BOM preserved. */
  readonly text: string;
  /** SHA-256 of the original bytes. */
  readonly sha256: string;
};

/** Active window limits. Defaults are the provisional values of specification 5.4. */
export type WindowLimits = {
  readonly targetTokens: number;
  readonly maxTokens: number;
  readonly maxBytes: number;
  readonly targetLines: number;
  readonly maxLines: number;
  readonly overlapLines: number;
};

export const DEFAULT_WINDOW_LIMITS: WindowLimits = Object.freeze({
  targetTokens: 800,
  maxTokens: 1_600,
  maxBytes: 8 * 1_024,
  targetLines: 80,
  maxLines: 120,
  overlapLines: 8,
});

/** Maximum overlap allowed by specification 5.4. */
export const MAX_WINDOW_OVERLAP_LINES = 8;

/** Chunker identity; part of fragment metadata and of evaluation identity. */
export const LINE_WINDOW_CHUNKER_VERSION = 'jevgrep-line-windows-1';

/** One contiguous original range prepared for evaluation. */
export type FragmentWindow = {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  /** 1-based inclusive line numbers. */
  readonly startLine: number;
  readonly endLine: number;
  /** UTF-8 byte offsets into the original file; `byteEnd` is exclusive. */
  readonly byteStart: number;
  readonly byteEnd: number;
  /** Exact original slice, never edited, stitched or truncated. */
  readonly text: string;
  readonly byteCount: number;
  readonly tokenCount: number;
  readonly chunker: string;
  readonly classification: 'line-window';
};

/** A file whose single line cannot become a legal fragment; reported, never truncated. */
export type UnsupportedLongLine = {
  readonly kind: 'unsupported-long-line';
  readonly line: number;
  readonly reason: 'unsupported_long_line';
  readonly byteCount: number;
  /** Not measured when the byte ceiling already makes this line ineligible. */
  readonly tokenCount: number | null;
};

export type LineWindowResult =
  | { readonly kind: 'windows'; readonly windows: readonly FragmentWindow[] }
  | UnsupportedLongLine;

/** Replaceable token counter so tests can pin the limits; production uses the pinned one. */
export type TokenCounter = (text: string) => number;

/**
 * Line metadata the window builder consumes. `SourceSnapshot` satisfies it directly, so
 * preparation reuses the snapshot's offsets, cached line costs and blank-line flags
 * instead of re-reading the text.
 */
export type LineIndex = {
  readonly lineCount: number;
  /** UTF-16 offset where a 1-based line starts, and just past its line ending. */
  lineStartUtf16(line: number): number;
  lineEndUtf16(line: number): number;
  /** UTF-8 offsets of the same boundaries. */
  lineStartByte(line: number): number;
  lineEndByte(line: number): number;
  /** Tokens of one line, including its ending, measured with the chunker's counter. */
  lineTokens(line: number): number;
  isBlankLine(line: number): boolean;
};

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Index the decoded text by line with UTF-16 and UTF-8 boundaries. A CRLF pair counts
 * as one line ending, and a terminal newline does not invent a trailing empty line.
 */
function indexLines(text: string, count: TokenCounter): LineIndex {
  const startsUtf16: number[] = [];
  const startsBytes: number[] = [];
  let byteOffset = 0;
  let lineStart = 0;
  let lineByteStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    byteOffset += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (codePoint === 10) {
      startsUtf16.push(lineStart);
      startsBytes.push(lineByteStart);
      lineStart = index + 1;
      lineByteStart = byteOffset;
    }
    index += characterLength - 1;
  }
  if (lineStart < text.length) {
    startsUtf16.push(lineStart);
    startsBytes.push(lineByteStart);
  }

  const lineCount = startsUtf16.length;
  const endUtf16 = (line: number): number => (line < lineCount ? (startsUtf16[line] ?? text.length) : text.length);
  const endByte = (line: number): number => (line < lineCount ? (startsBytes[line] ?? byteOffset) : byteOffset);
  const sliceOf = (line: number): string => text.slice(startsUtf16[line - 1] ?? 0, endUtf16(line));
  return {
    lineCount,
    lineStartUtf16: (line) => startsUtf16[line - 1] ?? 0,
    lineEndUtf16: endUtf16,
    lineStartByte: (line) => startsBytes[line - 1] ?? 0,
    lineEndByte: endByte,
    lineTokens: (line) => count(sliceOf(line)),
    isBlankLine: (line) => isBlank(sliceOf(line)),
  };
}

function isBlankRange(lines: LineIndex, startLine: number, endLine: number): boolean {
  for (let line = startLine; line <= endLine; line += 1) {
    if (!lines.isBlankLine(line)) {
      return false;
    }
  }
  return true;
}

function lineBytes(lines: LineIndex, line: number): number {
  return lines.lineEndByte(line) - lines.lineStartByte(line);
}

/** One window, verified against the active limits before it is returned. */
function buildWindow(
  lines: LineIndex,
  snapshot: SnapshotText,
  startLine: number,
  limits: WindowLimits,
  count: TokenCounter,
): FragmentWindow | UnsupportedLongLine {
  const firstBytes = lineBytes(lines, startLine);
  // Tokenizing an arbitrarily long word can be expensive. Apply the byte limit before
  // invoking BPE, and report an unmeasured token count rather than inventing a value.
  if (firstBytes > limits.maxBytes) {
    return { kind: 'unsupported-long-line', line: startLine, reason: 'unsupported_long_line', byteCount: firstBytes, tokenCount: null };
  }
  const startOffset = lines.lineStartUtf16(startLine);
  let tokenCount = lines.lineTokens(startLine);
  if (tokenCount > limits.maxTokens) {
    return { kind: 'unsupported-long-line', line: startLine, reason: 'unsupported_long_line', byteCount: firstBytes, tokenCount };
  }

  let endLine = startLine;
  let bytes = firstBytes;
  while (endLine < lines.lineCount) {
    const lineCount = endLine - startLine + 1;
    if (lineCount >= limits.targetLines || tokenCount >= limits.targetTokens) {
      break;
    }
    if (lineCount + 1 > limits.maxLines) {
      break;
    }
    const nextBytes = lineBytes(lines, endLine + 1);
    if (bytes + nextBytes > limits.maxBytes) {
      break;
    }
    // BPE merges can cross line endings, so each candidate is measured on its own text.
    const expandedTokens = count(snapshot.text.slice(startOffset, lines.lineEndUtf16(endLine + 1)));
    if (expandedTokens > limits.maxTokens) {
      break;
    }
    endLine += 1;
    bytes += nextBytes;
    tokenCount = expandedTokens;
  }

  const byteStart = lines.lineStartByte(startLine);
  const byteEnd = lines.lineEndByte(endLine);
  return {
    id: `${snapshot.path}#L${String(startLine)}-L${String(endLine)}`,
    path: snapshot.path,
    sha256: snapshot.sha256,
    startLine,
    endLine,
    byteStart,
    byteEnd,
    text: snapshot.text.slice(startOffset, lines.lineEndUtf16(endLine)),
    byteCount: byteEnd - byteStart,
    tokenCount,
    chunker: LINE_WINDOW_CHUNKER_VERSION,
    classification: 'line-window',
  };
}

/**
 * Split one prepared snapshot into contiguous line windows.
 *
 * A blank-only file produces no window. A file containing a line that cannot fit a legal
 * window is reported as `unsupported-long-line` instead of being truncated, so the caller
 * can exclude it explicitly (specification 5.2, exclusion reason `unsupported_long_line`).
 */
export function lineWindows(
  snapshot: SnapshotText,
  limits: WindowLimits = DEFAULT_WINDOW_LIMITS,
  count: TokenCounter = countReferenceTokens,
): LineWindowResult {
  return lineWindowsOf(snapshot, null, limits, count);
}

/**
 * Same windows as `lineWindows`, built on an existing line index. `lines.lineTokens`
 * must measure with `count`, so single-line costs are shared with the index's cache.
 */
export function lineWindowsOf(
  snapshot: SnapshotText,
  lines: LineIndex | null,
  limits: WindowLimits = DEFAULT_WINDOW_LIMITS,
  count: TokenCounter = countReferenceTokens,
): LineWindowResult {
  if (limits.targetLines < 1 || limits.targetTokens < 1 || limits.maxLines < 1 || limits.maxBytes < 1
    || limits.maxTokens < 1 || limits.overlapLines < 0 || limits.overlapLines > MAX_WINDOW_OVERLAP_LINES) {
    throw new RangeError(`window targets and limits must be positive, and overlap must be between 0 and ${String(MAX_WINDOW_OVERLAP_LINES)} lines`);
  }

  // Inventory normally excludes whitespace-only files, but keep this pure seam correct for
  // direct callers too. In particular, a very long blank line is not unsupported source.
  if (isBlank(snapshot.text)) {
    return { kind: 'windows', windows: [] };
  }

  const index = lines ?? indexLines(snapshot.text, count);
  const windows: FragmentWindow[] = [];
  let line = 1;

  while (line <= index.lineCount) {
    const built = buildWindow(index, snapshot, line, limits, count);
    if ('kind' in built) {
      return built;
    }
    if (!isBlankRange(index, built.startLine, built.endLine)) {
      windows.push(built);
    }
    if (built.endLine >= index.lineCount) {
      break;
    }
    line = Math.max(line + 1, built.endLine + 1 - limits.overlapLines);
  }

  return { kind: 'windows', windows };
}
