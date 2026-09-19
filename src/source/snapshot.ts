/**
 * Source snapshots and exact source references (JG-011).
 *
 * A snapshot is the bytes of one eligible file, read once, hashed once, and indexed
 * by line. Every excerpt the engine can ever return is a contiguous slice of a
 * snapshot: nothing is reprinted, normalized or regenerated (specification sections
 * 4.3 and 5.3).
 *
 * Invariants enforced here:
 * - lines are 1-based and ranges inclusive; CRLF is one line ending; a terminal
 *   newline does not invent an extra line;
 * - the SHA-256 covers the whole captured file, not a transformed copy or a fragment;
 * - a byte offset and a UTF-16 offset exist for every line start, so the lexical
 *   scanner (which works in UTF-16 like JavaScript strings) and the transmitted byte
 *   counters (which work in UTF-8) agree on the same lines;
 * - a BOM is preserved in both the bytes and the decoded text.
 */
import { createHash } from 'node:crypto';

/** Reason a byte buffer cannot become a snapshot. Both map onto contract exclusions. */
export type SnapshotRefusal = 'binary' | 'unsupported_encoding';

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
  readonly refusal: SnapshotRefusal;

  constructor(refusal: SnapshotRefusal, detail: string) {
    super(`${refusal}: ${detail}`);
    this.refusal = refusal;
  }
}

export type LineSlice = {
  /** Exact decoded text of the requested lines, including the final line ending when present. */
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly byteLength: number;
};

/** `ignoreBOM` keeps U+FEFF in the decoded text so text offsets track bytes one to one. */
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class SourceSnapshot {
  readonly relativePath: string;
  readonly absolutePath: string;
  /** Original bytes exactly as read. */
  readonly bytes: Buffer;
  /** Decoded text; `text.length` is a UTF-16 length, `bytes.length` a UTF-8 length. */
  readonly text: string;
  readonly sha256: string;
  readonly lineCount: number;
  readonly hasBom: boolean;
  readonly endsWithNewline: boolean;

  /** Start offsets of each line, indexed from 0 for line 1. */
  readonly #lineStartsUtf16: Int32Array;
  readonly #lineStartsBytes: Int32Array;
  readonly #lineTokens: Int32Array;
  #blankLines: Uint8Array | null = null;

  constructor(
    relativePath: string,
    absolutePath: string,
    bytes: Buffer,
    text: string,
    lineStartsUtf16: Int32Array,
    lineStartsBytes: Int32Array,
    lineTokens: Int32Array,
    sha256: string,
  ) {
    this.relativePath = relativePath;
    this.absolutePath = absolutePath;
    this.bytes = bytes;
    this.text = text;
    this.sha256 = sha256;
    this.#lineStartsUtf16 = lineStartsUtf16;
    this.#lineStartsBytes = lineStartsBytes;
    this.#lineTokens = lineTokens;
    this.lineCount = lineStartsUtf16.length;
    this.hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    this.endsWithNewline = text.endsWith('\n');
  }

  get byteLength(): number {
    return this.bytes.length;
  }

  #assertLine(line: number, label: string): void {
    if (!Number.isInteger(line) || line < 1 || line > this.lineCount) {
      throw new RangeError(`${label} ${String(line)} is outside 1..${String(this.lineCount)} for ${this.relativePath}`);
    }
  }

  /** UTF-16 offset where a line starts. */
  lineStartUtf16(line: number): number {
    this.#assertLine(line, 'line');
    return this.#lineStartsUtf16[line - 1] ?? 0;
  }

  /** UTF-16 offset just past a line, including its line ending when it has one. */
  lineEndUtf16(line: number): number {
    this.#assertLine(line, 'line');
    return line === this.lineCount ? this.text.length : (this.#lineStartsUtf16[line] ?? this.text.length);
  }

  /** Byte offset where a line starts. */
  lineStartByte(line: number): number {
    this.#assertLine(line, 'line');
    return this.#lineStartsBytes[line - 1] ?? 0;
  }

  lineEndByte(line: number): number {
    this.#assertLine(line, 'line');
    return line === this.lineCount ? this.bytes.length : (this.#lineStartsBytes[line] ?? this.bytes.length);
  }

  /** 1-based line containing a UTF-16 offset; used to map scanner positions to lines. */
  lineOfUtf16(offset: number): number {
    let low = 0;
    let high = this.lineCount - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.#lineStartsUtf16[middle] ?? 0) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low + 1;
  }

  /** Reference tokens of one line, including its line ending. */
  lineTokens(line: number): number {
    this.#assertLine(line, 'line');
    return this.#lineTokens[line - 1] ?? 0;
  }

  /**
   * Upper bound on the reference tokens of an inclusive line range.
   *
   * It sums per-line costs, which a BPE counter can beat by merging across a line
   * ending. Packing decisions use this bound because over-estimating keeps fragments
   * under their limits; a fragment's reported size is measured on its own text.
   */
  rangeTokens(startLine: number, endLine: number): number {
    this.#assertLine(startLine, 'start line');
    this.#assertLine(endLine, 'end line');
    let total = 0;
    for (let line = startLine; line <= endLine; line += 1) {
      total += this.#lineTokens[line - 1] ?? 0;
    }
    return total;
  }

  rangeBytes(startLine: number, endLine: number): number {
    return this.lineEndByte(endLine) - this.lineStartByte(startLine);
  }

  /** True when a line has no non-whitespace character. */
  isBlankLine(line: number): boolean {
    this.#assertLine(line, 'line');
    this.#blankLines ??= this.#computeBlankLines();
    return this.#blankLines[line - 1] === 1;
  }

  #computeBlankLines(): Uint8Array {
    const blanks = new Uint8Array(this.lineCount);
    for (let line = 1; line <= this.lineCount; line += 1) {
      const slice = this.text.slice(this.lineStartUtf16(line), this.lineEndUtf16(line));
      blanks[line - 1] = slice.trim().length === 0 ? 1 : 0;
    }
    return blanks;
  }

  /** True when every line of the file is blank; such a file carries no fragment. */
  isBlank(): boolean {
    return this.text.trim().length === 0;
  }

  /**
   * Exact contiguous slice of an inclusive line range.
   *
   * The slice runs from the first character of `startLine` to the first character of
   * the line after `endLine`, so it ends with that line's own line ending when the
   * file has one there. Two adjacent ranges therefore concatenate into exactly the
   * slice of their union, which is what overlap merging in JG-019 relies on.
   */
  sliceLines(startLine: number, endLine: number): LineSlice {
    this.#assertLine(startLine, 'start line');
    this.#assertLine(endLine, 'end line');
    if (endLine < startLine) {
      throw new RangeError(`inverted line range ${String(startLine)}..${String(endLine)} in ${this.relativePath}`);
    }
    const startUtf16 = this.lineStartUtf16(startLine);
    const endUtf16 = this.lineEndUtf16(endLine);
    const startByte = this.lineStartByte(startLine);
    const endByte = this.lineEndByte(endLine);
    return {
      text: this.text.slice(startUtf16, endUtf16),
      startLine, endLine, startByte, endByte,
      byteLength: endByte - startByte,
    };
  }
}

/** Reference-token cost of one character class boundary; mirrors the pinned counter. */
type LineTokenCounter = (text: string) => number;

/**
 * Build a snapshot from bytes already read through the authorized root.
 *
 * Invalid UTF-8 and embedded NUL bytes are refused explicitly rather than replaced by
 * substitution characters: a file whose bytes cannot be reproduced exactly has no
 * business being quoted back as evidence.
 */
export function createSnapshot(
  relativePath: string,
  absolutePath: string,
  bytes: Buffer,
  countTokens: LineTokenCounter,
): SourceSnapshot {
  if (bytes.includes(0)) {
    throw new SnapshotError('binary', `${relativePath} contains NUL bytes`);
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new SnapshotError('unsupported_encoding', `${relativePath} is not valid UTF-8`);
  }

  const lineStartsUtf16: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      lineStartsUtf16.push(index + 1);
    }
  }
  // A terminal newline closes the last line; it does not open a new one.
  if (lineStartsUtf16.length > 1 && lineStartsUtf16[lineStartsUtf16.length - 1] === text.length) {
    lineStartsUtf16.pop();
  }

  const lineStartsBytes: number[] = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      lineStartsBytes.push(index + 1);
    }
  }
  if (lineStartsBytes.length > 1 && lineStartsBytes[lineStartsBytes.length - 1] === bytes.length) {
    lineStartsBytes.pop();
  }
  /* istanbul ignore next -- both indexes count the same line feeds */
  if (lineStartsBytes.length !== lineStartsUtf16.length) {
    throw new SnapshotError('unsupported_encoding', `${relativePath} has inconsistent byte and text line indexes`);
  }

  const lineTokens = new Int32Array(lineStartsUtf16.length);
  for (let line = 0; line < lineStartsUtf16.length; line += 1) {
    const start = lineStartsUtf16[line] ?? 0;
    const end = line + 1 < lineStartsUtf16.length ? (lineStartsUtf16[line + 1] ?? text.length) : text.length;
    lineTokens[line] = countTokens(text.slice(start, end));
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return new SourceSnapshot(
    relativePath, absolutePath, bytes, text,
    Int32Array.from(lineStartsUtf16), Int32Array.from(lineStartsBytes), lineTokens, sha256,
  );
}

/** SHA-256 of arbitrary bytes, used for freshness revalidation in JG-021. */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
