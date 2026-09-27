/**
 * Statement and member boundaries for Java from a small lexical scanner.
 *
 * The scanner tokenizes comments, string, text-block and character literals and
 * tracks brackets; nothing is compiled or executed. Unterminated literals or
 * unbalanced brackets are reported as a parse failure so the caller can fall back to
 * line windows.
 */
import type { Boundary, ParseOutcome } from './javascript-boundaries.ts';

type MutableBoundary = { line: number; depth: number; label: string | null };

/** An open bracket. `{` is a `block` when it holds statements or members, `init` for an array initializer. */
type Frame =
  | { readonly char: '(' | '[' }
  | { readonly char: '{'; readonly kind: 'block' | 'init'; readonly owner: Statement | null };

type Statement = {
  readonly boundary: MutableBoundary | null;
  readonly depth: number;
  readonly firstWord: string;
  /** Header tokens up to the first `{`, `;` or `=` outside parentheses, for the label. */
  readonly header: string[];
  collecting: boolean;
};

class JavaScanError extends Error {}

const TYPE_KEYWORDS = new Set(['class', 'interface', 'enum', 'record']);
const NOT_METHOD_NAMES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new', 'throw', 'try', 'do', 'else',
  'super', 'this', 'assert', 'yield',
]);
const CONTINUES_AFTER_BLOCK = new Set(['else', 'catch', 'finally', ';', ',', ')', ']', '.', '?', ':', '+', '-',
  '*', '/', '%', '&', '|', '^', '<', '>', '=', '!']);

function isIdentifierCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f || code === 0x24 || code > 0x7f;
}

function labelOf(statement: Statement): string | null {
  const tokens = statement.header;
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (TYPE_KEYWORDS.has(token) && tokens[index - 1] !== '.' && isIdentifierCode(tokens[index + 1]!.charCodeAt(0))) {
      return `${tokens[index - 1] === '@' ? 'interface' : token}:${tokens[index + 1]!}`;
    }
  }
  if (statement.depth !== 1) {
    return null;
  }
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const token = tokens[index]!;
    const before = tokens[index - 1];
    if (tokens[index + 1] === '(' && isIdentifierCode(token.charCodeAt(0)) && !/^[0-9]/.test(token)
      && !NOT_METHOD_NAMES.has(token) && before !== '@' && before !== '.') {
      return `method:${token}`;
    }
  }
  return null;
}

/** Offset just past the literal opened at `start` by `"`, `"""` or `'`. */
function skipLiteral(text: string, start: number): number {
  const block = text.startsWith('"""', start);
  const delimiter = block ? '"""' : text[start]!;
  let index = start + delimiter.length;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (!block && (char === '\n' || char === '\r')) {
      break;
    }
    if (text.startsWith(delimiter, index)) {
      return index + delimiter.length;
    }
    index += 1;
  }
  throw new JavaScanError('unterminated literal');
}

function scan(text: string, lineOfOffset: (offset: number) => number): MutableBoundary[] {
  const boundaries: MutableBoundary[] = [];
  const frames: Frame[] = [];
  let blockDepth = 0;
  let parens = 0;
  let statement: Statement | null = null;
  let expectStart = true;
  let terminatorLine = 0;
  let commentStart: number | null = null;
  let previousToken = '';
  /** The block brace just closed, while its statement may still continue (`else`, `catch`, `while`). */
  let closed: Statement | null = null;

  const atStatementLevel = (): boolean => {
    const top = frames[frames.length - 1];
    return parens === 0 && (top === undefined || (top.char === '{' && top.kind === 'block'));
  };

  const endStatement = (offset: number): void => {
    if (statement !== null && statement.boundary !== null) {
      statement.boundary.label = labelOf(statement)?.slice(0, 160) ?? null;
    }
    statement = null;
    expectStart = true;
    terminatorLine = lineOfOffset(offset);
    commentStart = null;
  };

  const token = (value: string, offset: number): void => {
    if (closed !== null) {
      const resumed = closed;
      closed = null;
      if (CONTINUES_AFTER_BLOCK.has(value) || (value === 'while' && resumed.firstWord === 'do')) {
        statement = resumed;
        expectStart = false;
        commentStart = null;
      } else {
        const documentation = commentStart;
        statement = resumed;
        endStatement(offset - 1);
        commentStart = documentation;
      }
    }
    if (expectStart && atStatementLevel() && value !== ';' && value !== '}') {
      const start = commentStart ?? offset;
      const boundary: MutableBoundary | null = blockDepth <= 2
        ? { line: lineOfOffset(start), depth: blockDepth, label: null }
        : null;
      if (boundary !== null) {
        boundaries.push(boundary);
      }
      statement = { boundary, depth: blockDepth, firstWord: value, header: [], collecting: true };
      expectStart = false;
      commentStart = null;
    }
    const current = statement as Statement | null;
    if (current?.collecting === true && current.depth === blockDepth) {
      if (parens === 0 && (value === '{' || value === ';' || value === '=')) {
        current.collecting = false;
      } else if (current.header.length < 64) {
        current.header.push(value);
      }
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const code = char.charCodeAt(0);
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\uFEFF') {
      index += 1;
      continue;
    }
    if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      if ((expectStart || closed !== null) && commentStart === null && atStatementLevel()
        && lineOfOffset(index) > terminatorLine) {
        commentStart = index;
      }
      if (text[index + 1] === '/') {
        const end = text.indexOf('\n', index);
        index = end < 0 ? text.length : end;
      } else {
        const end = text.indexOf('*/', index + 2);
        if (end < 0) {
          throw new JavaScanError('unterminated comment');
        }
        index = end + 2;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      token('"', index);
      index = skipLiteral(text, index);
      previousToken = '"';
      continue;
    }
    if (isIdentifierCode(code)) {
      let end = index + 1;
      while (end < text.length && isIdentifierCode(text.charCodeAt(end))) {
        end += 1;
      }
      const word = text.slice(index, end);
      token(word, index);
      index = end;
      previousToken = word;
      continue;
    }

    token(char, index);
    if (char === '(' || char === '[') {
      frames.push({ char });
      parens += 1;
    } else if (char === ')' || char === ']') {
      const top = frames.pop();
      if (top?.char !== (char === ')' ? '(' : '[')) {
        throw new JavaScanError('unbalanced bracket');
      }
      parens -= 1;
    } else if (char === '{') {
      const top = frames[frames.length - 1];
      const initializer = parens === 0 && (previousToken === '=' || previousToken === ']' || previousToken === ','
        || (top?.char === '{' && top.kind === 'init'));
      if (initializer || !atStatementLevel()) {
        frames.push({ char: '{', kind: 'init', owner: null });
      } else {
        frames.push({ char: '{', kind: 'block', owner: statement });
        blockDepth += 1;
        statement = null;
        expectStart = true;
        terminatorLine = lineOfOffset(index);
        commentStart = null;
      }
    } else if (char === '}') {
      const top = frames.pop();
      if (top?.char !== '{') {
        throw new JavaScanError('unbalanced brace');
      }
      if (top.kind === 'block') {
        if (statement !== null) {
          endStatement(index);
        }
        blockDepth -= 1;
        statement = top.owner;
        expectStart = false;
        closed = top.owner;
        if (closed === null) {
          expectStart = true;
        }
        terminatorLine = lineOfOffset(index);
        commentStart = null;
      }
    } else if (char === ';' && atStatementLevel()) {
      endStatement(index);
    }
    previousToken = char;
    index += 1;
  }
  if (frames.length > 0) {
    throw new JavaScanError('unclosed bracket');
  }
  if (closed !== null) {
    statement = closed;
  }
  if (statement !== null) {
    endStatement(text.length);
  }
  return boundaries;
}

/**
 * Package, import and type declarations are depth 0, members of top-level types depth
 * 1 and statements inside those members depth 2. Annotations and own-line comments
 * stay attached to the declaration they precede.
 */
export function parseJavaBoundaries(text: string, lineOfOffset: (offset: number) => number): ParseOutcome {
  let found: MutableBoundary[];
  try {
    found = scan(text, lineOfOffset);
  } catch (cause) {
    if (cause instanceof JavaScanError) {
      return { ok: false, reason: 'parse_failure' };
    }
    throw cause;
  }
  const seen = new Set<string>();
  const boundaries: Boundary[] = [];
  for (const boundary of found) {
    const key = `${String(boundary.depth)}:${String(boundary.line)}`;
    if (!seen.has(key)) {
      seen.add(key);
      boundaries.push({ ...boundary });
    }
  }
  boundaries.sort((a, b) => a.line - b.line || a.depth - b.depth);
  return { ok: true, boundaries };
}
