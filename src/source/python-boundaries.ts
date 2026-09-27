/**
 * Statement boundaries for Python from a small lexical scanner.
 *
 * The scanner only tokenizes strings, comments, brackets and line continuations to find
 * logical lines and their indentation; nothing is imported, compiled or executed. Any
 * lexical or indentation inconsistency is reported as a parse failure so the caller can
 * fall back to line windows.
 */
import type { Boundary, ParseOutcome } from './javascript-boundaries.ts';

type LogicalLine = {
  /** UTF-16 offset of the first token, and of the first own-line comment preceding it. */
  readonly start: number;
  readonly commentStart: number | null;
  readonly indent: number;
  readonly endsWithColon: boolean;
  readonly head: string;
};

type MutableBoundary = { line: number; depth: number; label: string | null };

class PythonScanError extends Error {}

const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
const STRING_PREFIX = /^(?:[rRbBuUfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;
const DEF = /^(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)/u;
const CLASS = /^class\s+([\p{L}_][\p{L}\p{N}_]*)/u;

function isIdentifierCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f || code > 0x7f;
}

/** Offset just past a string literal whose opening quote is at `quote`. */
function skipString(text: string, quote: number): number {
  const mark = text[quote]!;
  const triple = text.startsWith(mark.repeat(3), quote);
  const delimiter = triple ? mark.repeat(3) : mark;
  let index = quote + delimiter.length;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') {
      index += text.startsWith('\r\n', index + 1) ? 3 : 2;
      continue;
    }
    if (!triple && (char === '\n' || char === '\r')) {
      throw new PythonScanError('unterminated string');
    }
    if (text.startsWith(delimiter, index)) {
      return index + delimiter.length;
    }
    index += 1;
  }
  throw new PythonScanError('unterminated string');
}

function scanLogicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  const brackets: string[] = [];
  let lineStart = 0;
  let current: { start: number; commentStart: number | null; indent: number; last: string } | null = null;
  let commentStart: number | null = null;
  let continued = false;

  const close = (end: number): void => {
    if (current !== null) {
      lines.push({
        start: current.start, commentStart: current.commentStart, indent: current.indent,
        endsWithColon: current.last === ':', head: text.slice(current.start, Math.min(end, current.start + 400)),
      });
      current = null;
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\n') {
      if (brackets.length === 0 && !continued) {
        close(index);
      }
      continued = false;
      lineStart = index + 1;
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\uFEFF') {
      index += 1;
      continue;
    }
    if (char === '\\') {
      if (text[index + 1] === '\n' || (text[index + 1] === '\r' && text[index + 2] === '\n')) {
        continued = true;
        index += text[index + 1] === '\n' ? 1 : 2;
        continue;
      }
      throw new PythonScanError('stray backslash');
    }
    if (char === '#') {
      if (current === null && commentStart === null) {
        commentStart = index;
      }
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
      continue;
    }

    if (current === null) {
      let indent = 0;
      for (let column = lineStart; column < index; column += 1) {
        const space = text[column];
        indent = space === '\t' ? indent + 8 - (indent % 8) : space === '\f' || space === '\uFEFF' ? 0 : indent + 1;
      }
      current = { start: index, commentStart, indent, last: '' };
      commentStart = null;
    }

    const code = char.charCodeAt(0);
    if (char === '"' || char === "'") {
      index = skipString(text, index);
      current.last = 'string';
      continue;
    }
    if (isIdentifierCode(code)) {
      let end = index + 1;
      while (end < text.length && isIdentifierCode(text.charCodeAt(end))) {
        end += 1;
      }
      const next = text[end];
      if ((next === '"' || next === "'") && STRING_PREFIX.test(text.slice(index, end))) {
        index = skipString(text, end);
        current.last = 'string';
        continue;
      }
      index = end;
      current.last = 'name';
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      brackets.push(char);
    } else if (char === ')' || char === ']' || char === '}') {
      if (brackets.pop() !== CLOSERS[char]) {
        throw new PythonScanError('unbalanced bracket');
      }
    }
    current.last = char;
    index += 1;
  }
  if (brackets.length > 0 || continued) {
    throw new PythonScanError('unterminated logical line');
  }
  close(text.length);
  return lines;
}

/**
 * Logical-line boundaries: module statements are depth 0, the bodies of top-level
 * compound statements depth 1, and the next level depth 2. Decorators and own-line
 * comments stay attached to the statement they precede.
 */
export function parsePythonBoundaries(text: string, lineOfOffset: (offset: number) => number): ParseOutcome {
  let logical: LogicalLine[];
  try {
    logical = scanLogicalLines(text);
  } catch (cause) {
    if (cause instanceof PythonScanError) {
      return { ok: false, reason: 'parse_failure' };
    }
    throw cause;
  }

  const indents = [0];
  const kinds: ('class' | 'other')[] = ['other'];
  const boundaries: MutableBoundary[] = [];
  let previous: LogicalLine | null = null;
  let previousKind: 'class' | 'other' = 'other';
  let decorated: MutableBoundary | null = null;

  for (const line of logical) {
    const top = indents[indents.length - 1]!;
    if (line.indent > top) {
      if (previous?.endsWithColon !== true) {
        return { ok: false, reason: 'parse_failure' };
      }
      indents.push(line.indent);
      kinds.push(previousKind);
      decorated = null;
    } else {
      if (previous?.endsWithColon === true) {
        return { ok: false, reason: 'parse_failure' };
      }
      while (indents.length > 1 && indents[indents.length - 1]! > line.indent) {
        indents.pop();
        kinds.pop();
        decorated = null;
      }
      if (indents[indents.length - 1] !== line.indent) {
        return { ok: false, reason: 'parse_failure' };
      }
    }

    const depth = indents.length - 1;
    const definition = DEF.exec(line.head);
    const type = CLASS.exec(line.head);
    const label = definition !== null
      ? `${kinds[kinds.length - 1] === 'class' ? 'method' : 'function'}:${definition[1]!}`
      : type !== null ? `class:${type[1]!}` : null;
    previousKind = type !== null ? 'class' : 'other';
    previous = line;

    if (depth > 2) {
      continue;
    }
    if (decorated !== null && decorated.depth === depth) {
      if (!line.head.startsWith('@')) {
        decorated.label = label?.slice(0, 160) ?? null;
        decorated = null;
      }
      continue;
    }
    const boundary: MutableBoundary = { line: lineOfOffset(line.commentStart ?? line.start), depth, label: label?.slice(0, 160) ?? null };
    boundaries.push(boundary);
    decorated = line.head.startsWith('@') ? boundary : null;
  }
  if (previous?.endsWithColon === true) {
    return { ok: false, reason: 'parse_failure' };
  }

  const result: Boundary[] = boundaries.map((boundary) => ({ ...boundary }));
  result.sort((a, b) => a.line - b.line || a.depth - b.depth);
  return { ok: true, boundaries: result };
}
