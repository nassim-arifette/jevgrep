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
  readonly tokenCount: number;
};

export type LineWindowResult =
  | { readonly kind: 'windows'; readonly windows: readonly FragmentWindow[] }
  | UnsupportedLongLine;

/** Replaceable token counter so tests can pin the limits; production uses the pinned one. */
export type TokenCounter = (text: string) => number;

type LineRecord = {
  readonly number: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly byteCount: number;
};

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Split the decoded text into lines with UTF-16 and UTF-8 boundaries. A CRLF pair counts
 * as one line ending, and a terminal newline does not invent a trailing empty line.
 */
function readLines(text: string): readonly LineRecord[] {
  const lines: LineRecord[] = [];
  let byteOffset = 0;
  let lineStart = 0;
  let lineByteStart = 0;
  let lineNumber = 0;

  const pushLine = (endOffset: number, byteEndIncludingEnding: number): void => {
    lineNumber += 1;
    lines.push({
      number: lineNumber,
      startOffset: lineStart,
      endOffset: endOffset,
      byteStart: lineByteStart,
      byteEnd: byteEndIncludingEnding,
      byteCount: byteEndIncludingEnding - lineByteStart,
    });
  };

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    const characterBytes = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    byteOffset += characterBytes;

    if (codePoint === 10) {
      pushLine(index + 1, byteOffset);
      lineStart = index + 1;
      lineByteStart = byteOffset;
    }
    index += characterLength - 1;
  }

  if (lineStart < text.length) {
    pushLine(text.length, byteOffset);
  }
  return lines;
}

function textOf(lines: readonly LineRecord[], text: string, startIndex: number, endIndex: number): string {
  const start = lines[startIndex];
  const end = lines[endIndex];
  if (start === undefined || end === undefined) {
    return '';
  }
  return text.slice(start.startOffset, end.endOffset);
}

/** One window, verified against the active limits before it is returned. */
function buildWindow(
  lines: readonly LineRecord[],
  text: string,
  snapshot: SnapshotText,
  startIndex: number,
  limits: WindowLimits,
  count: TokenCounter,
): { readonly window: FragmentWindow | undefined; readonly oversized: UnsupportedLongLine | undefined } {
  const first = lines[startIndex];
  if (first === undefined) {
    return { window: undefined, oversized: undefined };
  }
  let candidate = textOf(lines, text, startIndex, startIndex);
  let tokenCount = count(candidate);
  if (first.byteCount > limits.maxBytes || tokenCount > limits.maxTokens) {
    return {
      window: undefined,
      oversized: { kind: 'unsupported-long-line', line: first.number, reason: 'unsupported_long_line', byteCount: first.byteCount, tokenCount },
    };
  }

  let endIndex = startIndex;
  let bytes = first.byteCount;
  while (endIndex + 1 < lines.length) {
    const next = lines[endIndex + 1];
    if (next === undefined) {
      break;
    }
    const lineCount = endIndex - startIndex + 1;
    if (lineCount >= limits.targetLines || tokenCount >= limits.targetTokens) {
      break;
    }
    if (endIndex + 1 - startIndex + 1 > limits.maxLines) {
      break;
    }
    if (bytes + next.byteCount > limits.maxBytes) {
      break;
    }
    const expanded = textOf(lines, text, startIndex, endIndex + 1);
    const expandedTokens = count(expanded);
    if (expandedTokens > limits.maxTokens) {
      break;
    }
    endIndex += 1;
    bytes += next.byteCount;
    candidate = expanded;
    tokenCount = expandedTokens;
  }

  const last = lines[endIndex];
  if (last === undefined) {
    return { window: undefined, oversized: undefined };
  }

  return {
    window: {
      id: `${snapshot.path}#L${String(first.number)}-L${String(last.number)}`,
      path: snapshot.path,
      sha256: snapshot.sha256,
      startLine: first.number,
      endLine: last.number,
      byteStart: first.byteStart,
      byteEnd: last.byteEnd,
      text: candidate,
      byteCount: last.byteEnd - first.byteStart,
      tokenCount,
      chunker: LINE_WINDOW_CHUNKER_VERSION,
      classification: 'line-window',
    },
    oversized: undefined,
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
  if (limits.targetLines < 1 || limits.targetTokens < 1 || limits.maxLines < 1 || limits.maxBytes < 1
    || limits.maxTokens < 1 || limits.overlapLines < 0) {
    throw new RangeError('window targets and limits must be positive, and overlap cannot be negative');
  }

  const lines = readLines(snapshot.text);
  const windows: FragmentWindow[] = [];
  let index = 0;

  while (index < lines.length) {
    const { window, oversized } = buildWindow(lines, snapshot.text, snapshot, index, limits, count);
    if (oversized !== undefined) {
      return oversized;
    }
    if (window === undefined) {
      break;
    }
    const lastIndex = index + (window.endLine - window.startLine);
    const blank = textOf(lines, snapshot.text, index, lastIndex);
    if (!isBlank(blank)) {
      windows.push(window);
    }
    if (lastIndex + 1 >= lines.length) {
      break;
    }
    const nextIndex = Math.max(index + 1, lastIndex + 1 - limits.overlapLines);
    index = nextIndex;
  }

  return { kind: 'windows', windows };
}
