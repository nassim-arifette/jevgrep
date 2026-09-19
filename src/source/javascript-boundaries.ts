/**
 * JavaScript/TypeScript statement boundaries for the syntax chunker (JG-015).
 *
 * The chunker needs to know where top-level declarations, statements and class
 * members begin, so that a fragment can end on a real construct instead of an
 * arbitrary line. It does **not** need types, symbols or a full AST.
 *
 * Why a scanner and not the TypeScript compiler: the specification recommends the
 * TypeScript syntax parser, but the pinned `typescript@7.0.2` package exposes no
 * usable syntax-parsing entry point (no `createSourceFile`; its `unstable/ast`
 * scanner returned inconsistent token positions in a probe on this runtime). Pulling
 * an unpinned second compiler into an offline package was the worse trade, so this
 * module reads the source lexically — strings, template literals, comments, regular
 * expressions and JSX — and tracks nesting depth. It never evaluates, imports,
 * compiles or type-checks anything it reads (requirement R11).
 *
 * The scanner reports failure instead of guessing: an unterminated literal or an
 * unbalanced brace returns `ok: false` and the caller falls back to line windows
 * with a diagnostic (specification section 5.4).
 */

export type Boundary = {
  /** 1-based line on which the construct starts, including its attached leading comments. */
  readonly line: number;
  /** Nesting depth: 0 for top-level statements, 1 for class members and block statements. */
  readonly depth: number;
  readonly label: string | null;
};

export type ScanOutcome =
  | { readonly ok: true; readonly boundaries: readonly Boundary[] }
  | { readonly ok: false; readonly reason: 'unterminated' | 'unbalanced' };

export type ScanOptions = {
  /** Enable JSX element scanning; only for `.jsx` and `.tsx` sources. */
  readonly jsx: boolean;
  /** Deepest nesting level that still records boundaries. Bounds the work and the output. */
  readonly maxDepth?: number;
};

const DECLARATION_KEYWORDS = new Set([
  'import', 'export', 'const', 'let', 'var', 'function', 'class', 'async', 'type',
  'interface', 'enum', 'declare', 'namespace', 'module', 'abstract', 'return',
  'if', 'for', 'while', 'switch', 'try', 'throw', 'do', 'with',
]);

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

const NAMED_CONSTRUCTS = new Set(['function', 'class', 'const', 'let', 'var', 'interface', 'type', 'enum', 'namespace']);

type TokenKind = 'none' | 'word' | 'number' | 'string' | 'punct' | 'closer';

function isIdentifierStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f || code === 0x24 || code > 0x7f;
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 0x30 && code <= 0x39);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Scan a JavaScript/TypeScript source and report where constructs begin.
 *
 * `lineOfOffset` maps a UTF-16 offset to a 1-based line, so the caller's snapshot
 * stays the single source of truth for line numbering.
 */
export function scanJavaScriptBoundaries(
  text: string,
  lineOfOffset: (offset: number) => number,
  options: ScanOptions,
): ScanOutcome {
  const maxDepth = options.maxDepth ?? 2;
  const boundaries: Boundary[] = [];
  const seenLines = new Set<number>();

  let index = 0;
  let depth = 0;
  let lastKind: TokenKind = 'none';
  let lastWord = '';
  let lastTokenLine = 0;
  let expectStatement = true;
  /** First line of the comment run that may belong to the next construct. */
  let commentRunStart: number | null = null;
  let commentRunEnd: number | null = null;
  /** Brace depths at which a template-literal expression was opened. */
  const templateStack: number[] = [];

  const fail = (reason: 'unterminated' | 'unbalanced'): ScanOutcome => ({ ok: false, reason });

  const record = (offset: number, label: string | null): void => {
    if (depth > maxDepth) {
      return;
    }
    const tokenLine = lineOfOffset(offset);
    const startLine = commentRunStart !== null && commentRunEnd !== null && commentRunEnd >= tokenLine - 1
      ? commentRunStart
      : tokenLine;
    if (seenLines.has(startLine)) {
      return;
    }
    seenLines.add(startLine);
    boundaries.push({ line: startLine, depth, label });
  };

  /** Read an identifier or keyword and return its text. */
  const readWord = (start: number): string => {
    let end = start;
    while (end < text.length && isIdentifierPart(text.charCodeAt(end))) {
      end += 1;
    }
    return text.slice(start, end);
  };

  /** Label for a construct: kind plus name when the source states one. */
  const labelAt = (start: number, word: string): string | null => {
    if (!NAMED_CONSTRUCTS.has(word) && word !== 'import' && word !== 'export') {
      return null;
    }
    if (word === 'import' || word === 'export') {
      return word;
    }
    let cursor = start + word.length;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x20 || code === 0x09) {
        cursor += 1;
        continue;
      }
      if (isIdentifierStart(code)) {
        const name = readWord(cursor);
        // `export const` and friends: keep walking to the actual name.
        return DECLARATION_KEYWORDS.has(name) && name !== word
          ? labelAt(cursor, name)
          : `${word}:${name}`;
      }
      break;
    }
    return word;
  };

  while (index < text.length) {
    const code = text.charCodeAt(index);

    // Whitespace and line breaks: trivia, but they end a comment run's adjacency.
    if (code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a) {
      index += 1;
      continue;
    }

    // Comments.
    if (code === 0x2f && text.charCodeAt(index + 1) === 0x2f) {
      const line = lineOfOffset(index);
      commentRunStart = commentRunEnd !== null && commentRunEnd >= line - 1 && commentRunStart !== null ? commentRunStart : line;
      commentRunEnd = line;
      while (index < text.length && text.charCodeAt(index) !== 0x0a) {
        index += 1;
      }
      continue;
    }
    if (code === 0x2f && text.charCodeAt(index + 1) === 0x2a) {
      const startLine = lineOfOffset(index);
      const end = text.indexOf('*/', index + 2);
      if (end === -1) {
        return fail('unterminated');
      }
      commentRunStart = commentRunEnd !== null && commentRunEnd >= startLine - 1 && commentRunStart !== null ? commentRunStart : startLine;
      index = end + 2;
      commentRunEnd = lineOfOffset(index - 1);
      continue;
    }

    // JSX: only when the file may contain it and we are in an expression position.
    if (options.jsx && code === 0x3c && (lastKind === 'none' || lastKind === 'punct')) {
      const next = text.charCodeAt(index + 1);
      if (isIdentifierStart(next) || next === 0x3e || next === 0x2f) {
        const outcome = scanJsxElement(text, index);
        if (outcome === null) {
          return fail('unterminated');
        }
        index = outcome;
        lastKind = 'closer';
        lastWord = '';
        commentRunStart = null;
        commentRunEnd = null;
        continue;
      }
    }

    // String literals.
    if (code === 0x22 || code === 0x27) {
      const end = skipQuoted(text, index, code);
      if (end === null) {
        return fail('unterminated');
      }
      if (expectStatement) {
        record(index, null);
        expectStatement = false;
      }
      index = end;
      lastKind = 'string';
      lastWord = '';
      lastTokenLine = lineOfOffset(index - 1);
      commentRunStart = null;
      commentRunEnd = null;
      continue;
    }

    // Template literals, including `${ ... }` expression holes.
    if (code === 0x60) {
      if (expectStatement) {
        record(index, null);
        expectStatement = false;
      }
      const outcome = skipTemplateChunk(text, index + 1);
      if (outcome === null) {
        return fail('unterminated');
      }
      if (outcome.openedExpression) {
        templateStack.push(depth);
        depth += 1;
      }
      index = outcome.end;
      lastKind = outcome.openedExpression ? 'punct' : 'string';
      lastWord = '';
      commentRunStart = null;
      commentRunEnd = null;
      continue;
    }

    // Regular expressions, distinguished from division by the previous token.
    if (code === 0x2f && (lastKind === 'none' || lastKind === 'punct'
      || (lastKind === 'word' && REGEX_PRECEDING_KEYWORDS.has(lastWord)))) {
      const end = skipRegex(text, index);
      if (end === null) {
        return fail('unterminated');
      }
      if (expectStatement) {
        record(index, null);
        expectStatement = false;
      }
      index = end;
      lastKind = 'string';
      lastWord = '';
      commentRunStart = null;
      commentRunEnd = null;
      continue;
    }

    // Identifiers and keywords.
    if (isIdentifierStart(code)) {
      const word = readWord(index);
      const line = lineOfOffset(index);
      const startsLine = isFirstOnLine(text, index);
      if (expectStatement
        || (depth <= maxDepth && startsLine && line > lastTokenLine
          && DECLARATION_KEYWORDS.has(word) && continuesStatement(lastKind, lastWord) === false)) {
        record(index, labelAt(index, word));
        expectStatement = false;
      }
      index += word.length;
      lastKind = 'word';
      lastWord = word;
      lastTokenLine = line;
      commentRunStart = null;
      commentRunEnd = null;
      continue;
    }

    // Numbers: only their leading digit matters for token classification.
    if (isDigit(code)) {
      if (expectStatement) {
        record(index, null);
        expectStatement = false;
      }
      index += 1;
      while (index < text.length && (isIdentifierPart(text.charCodeAt(index)) || text.charCodeAt(index) === 0x2e)) {
        index += 1;
      }
      lastKind = 'number';
      lastWord = '';
      lastTokenLine = lineOfOffset(index - 1);
      commentRunStart = null;
      commentRunEnd = null;
      continue;
    }

    // Punctuation, nesting and statement separators.
    const character = text[index] ?? '';
    if (expectStatement && (character === '@' || character === '(' || character === '[' || character === '{' || character === '#')) {
      record(index, character === '@' ? 'decorator' : null);
      expectStatement = false;
    }
    if (character === '{' || character === '(' || character === '[') {
      depth += 1;
      expectStatement = character === '{';
    } else if (character === '}' || character === ')' || character === ']') {
      depth -= 1;
      if (depth < 0) {
        return fail('unbalanced');
      }
      if (character === '}' && templateStack.length > 0 && templateStack[templateStack.length - 1] === depth) {
        // Closing a `${` hole: resume the surrounding template literal.
        templateStack.pop();
        const outcome = skipTemplateChunk(text, index + 1);
        if (outcome === null) {
          return fail('unterminated');
        }
        if (outcome.openedExpression) {
          templateStack.push(depth);
          depth += 1;
        }
        index = outcome.end;
        lastKind = 'string';
        lastWord = '';
        continue;
      }
      expectStatement = character === '}';
    } else if (character === ';') {
      expectStatement = true;
    }

    lastKind = character === ')' || character === ']' || character === '}' ? 'closer' : 'punct';
    lastWord = '';
    lastTokenLine = lineOfOffset(index);
    commentRunStart = null;
    commentRunEnd = null;
    index += 1;
  }

  if (depth !== 0 || templateStack.length > 0) {
    return fail('unbalanced');
  }
  boundaries.sort((left, right) => left.line - right.line);
  return { ok: true, boundaries };
}

/** A previous token that leaves an expression open, so a new line continues it. */
function continuesStatement(lastKind: TokenKind, lastWord: string): boolean {
  if (lastKind === 'punct') {
    return true;
  }
  return lastKind === 'word' && REGEX_PRECEDING_KEYWORDS.has(lastWord);
}

function isFirstOnLine(text: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const code = text.charCodeAt(cursor);
    if (code === 0x0a) {
      return true;
    }
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d) {
      return false;
    }
  }
  return true;
}

/** Skip a single- or double-quoted string; returns the offset just past it. */
function skipQuoted(text: string, start: number, quote: number): number | null {
  let index = start + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x5c) {
      index += 2;
      continue;
    }
    if (code === quote) {
      return index + 1;
    }
    if (code === 0x0a) {
      return null;
    }
    index += 1;
  }
  return null;
}

/**
 * Skip a template-literal chunk starting just after a backtick or a `}` hole close.
 * Reports whether the chunk ended by opening a `${` expression.
 */
function skipTemplateChunk(text: string, start: number): { end: number; openedExpression: boolean } | null {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x5c) {
      index += 2;
      continue;
    }
    if (code === 0x60) {
      return { end: index + 1, openedExpression: false };
    }
    if (code === 0x24 && text.charCodeAt(index + 1) === 0x7b) {
      return { end: index + 2, openedExpression: true };
    }
    index += 1;
  }
  return null;
}

/** Skip a regular-expression literal, including character classes and flags. */
function skipRegex(text: string, start: number): number | null {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x5c) {
      index += 2;
      continue;
    }
    if (code === 0x0a) {
      return null;
    }
    if (code === 0x5b) {
      inClass = true;
    } else if (code === 0x5d) {
      inClass = false;
    } else if (code === 0x2f && !inClass) {
      index += 1;
      while (index < text.length && isIdentifierPart(text.charCodeAt(index))) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return null;
}

/**
 * Skip a complete JSX element, including children, nested elements and `{ }`
 * expression holes. Returns the offset just past the element, or null when the
 * element is not terminated.
 */
function scanJsxElement(text: string, start: number): number | null {
  let index = start;
  let elementDepth = 0;

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code !== 0x3c) {
      index += 1;
      continue;
    }
    const closing = text.charCodeAt(index + 1) === 0x2f;
    index += closing ? 2 : 1;

    // Tag body: attributes, strings and `{ }` expressions until `>` or `/>`.
    let selfClosing = false;
    let closed = false;
    while (index < text.length) {
      const inner = text.charCodeAt(index);
      if (inner === 0x22 || inner === 0x27) {
        const end = skipQuoted(text, index, inner);
        if (end === null) {
          return null;
        }
        index = end;
        continue;
      }
      if (inner === 0x7b) {
        const end = skipBracedExpression(text, index);
        if (end === null) {
          return null;
        }
        index = end;
        continue;
      }
      if (inner === 0x2f && text.charCodeAt(index + 1) === 0x3e) {
        selfClosing = true;
        index += 2;
        closed = true;
        break;
      }
      if (inner === 0x3e) {
        index += 1;
        closed = true;
        break;
      }
      index += 1;
    }
    if (!closed) {
      return null;
    }

    if (closing) {
      elementDepth -= 1;
    } else if (!selfClosing) {
      elementDepth += 1;
    }
    if (elementDepth === 0) {
      return index;
    }
    if (elementDepth < 0) {
      return null;
    }

    // Children: text until the next tag, with `{ }` holes scanned as expressions.
    while (index < text.length) {
      const child = text.charCodeAt(index);
      if (child === 0x3c) {
        break;
      }
      if (child === 0x7b) {
        const end = skipBracedExpression(text, index);
        if (end === null) {
          return null;
        }
        index = end;
        continue;
      }
      index += 1;
    }
  }
  return null;
}

/** Skip a `{ ... }` region, respecting strings, templates and comments inside it. */
function skipBracedExpression(text: string, start: number): number | null {
  let index = start + 1;
  let depth = 1;
  while (index < text.length && depth > 0) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x27) {
      const end = skipQuoted(text, index, code);
      if (end === null) {
        return null;
      }
      index = end;
      continue;
    }
    if (code === 0x60) {
      const end = skipTemplateLiteral(text, index);
      if (end === null) {
        return null;
      }
      index = end;
      continue;
    }
    if (code === 0x2f && text.charCodeAt(index + 1) === 0x2f) {
      while (index < text.length && text.charCodeAt(index) !== 0x0a) {
        index += 1;
      }
      continue;
    }
    if (code === 0x2f && text.charCodeAt(index + 1) === 0x2a) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) {
        return null;
      }
      index = end + 2;
      continue;
    }
    if (code === 0x7b) {
      depth += 1;
    } else if (code === 0x7d) {
      depth -= 1;
    }
    index += 1;
  }
  return depth === 0 ? index : null;
}

/** Skip a whole template literal including its expression holes. */
function skipTemplateLiteral(text: string, start: number): number | null {
  let index = start + 1;
  for (;;) {
    const chunk = skipTemplateChunk(text, index);
    if (chunk === null) {
      return null;
    }
    if (!chunk.openedExpression) {
      return chunk.end;
    }
    // `chunk.end` sits just past `${`, so the brace scanner starts on that `{`.
    const closed = skipBracedExpression(text, chunk.end - 1);
    if (closed === null) {
      return null;
    }
    index = closed;
  }
}
