/**
 * Recursive JS/TS chunk planning (roadmap section 7, experiment E1).
 *
 * A cAST-style policy on the pinned TypeScript parser: a node that fits the active
 * limits stays whole and is packed with neighbouring siblings; an oversized node is
 * split along its own children, recursively and without a fixed depth, before line
 * windows are used as the last resort. The plan is made of line ranges only; the
 * caller slices fragments from the verified snapshot, so returned source is never
 * transformed.
 *
 * Every range carries the chain of named symbols that encloses it (function, class,
 * method, named arrow function, component, callback, JSX element). That chain is
 * request metadata (`Structure:`), never spliced into the excerpt. The default `local`
 * policy labels a range only with the symbol it starts (the previous convention, now
 * also for named arrow functions, components and callbacks); `enclosing` and `compact`
 * render the whole chain so boundaries and context can be compared separately (E1).
 * On the pinned JS/TS tasks the chain did not improve retrieval, so it is not the default.
 *
 * A file with syntax errors keeps structural ranges for the top-level statements that
 * contain no diagnostic; the statements that do are split into plain line windows. If
 * the damaged statements cover most of the file, the whole file falls back instead.
 */
import ts from 'typescript-parser';
import type { WindowLimits } from './line-windows.ts';
import type { SourceSnapshot } from './snapshot.ts';

export type JavaScriptContextPolicy = 'enclosing' | 'compact' | 'local';

export type PlannedRange = {
  readonly startLine: number;
  readonly endLine: number;
  readonly label: string | null;
  /** No usable syntax inside: the caller splits the range into line windows. */
  readonly windows: boolean;
  /** Label every window of a split range, not only the first. */
  readonly labelEveryWindow: boolean;
};

export type JavaScriptPlan =
  | { readonly ok: true; readonly ranges: readonly PlannedRange[]; readonly recovered: boolean }
  | { readonly ok: false; readonly reason: 'parse_failure' };

type SymbolInfo = {
  readonly kind: string;
  readonly name: string;
  readonly signature: string | null;
  readonly startLine: number;
  readonly endLine: number;
};

type Chunk = {
  startLine: number;
  endLine: number;
  ancestry: readonly SymbolInfo[];
  own: SymbolInfo | null;
  windows: boolean;
  /** A top-level statement containing a parse diagnostic. */
  damaged?: true;
};

type Unit = { startLine: number; endLine: number; nodes: ts.Node[] };

/** Ranges at or below this many reference tokens are merged into a neighbour when possible. */
const TINY_TOKENS = 64;
/** A small header (`function f() {`, `if (x) {`) is carried into the oversized node it opens. */
const HEADER_TOKENS = 160;
const MAX_DEPTH = 400;
const MAX_LABEL_CHARACTERS = 400;
const MAX_NAME_CHARACTERS = 80;
const MAX_SIGNATURE_CHARACTERS = 120;
/** Above this share of damaged lines, structural recovery is not trusted. */
const MAX_RECOVERED_SHARE = 0.5;

function scriptKindOf(path: string): ts.ScriptKind {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  return ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

const compress = (text: string): string => text.replace(/\s+/g, ' ').trim();

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

const isFunctionLike = (node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** Planner over one parsed file. */
class Planner {
  readonly #snapshot: SourceSnapshot;
  readonly #source: ts.SourceFile;
  readonly #text: string;
  readonly #limits: WindowLimits;
  readonly #starts = new Map<ts.Node, number>();

  constructor(snapshot: SourceSnapshot, source: ts.SourceFile, limits: WindowLimits) {
    this.#snapshot = snapshot;
    this.#source = source;
    this.#text = snapshot.text;
    this.#limits = limits;
  }

  line(offset: number): number {
    return this.#snapshot.lineOfUtf16(offset);
  }

  /** First line of a node, including the comments and decorators that precede it. */
  startLine(node: ts.Node): number {
    const cached = this.#starts.get(node);
    if (cached !== undefined) return cached;
    const comments = ts.getLeadingCommentRanges(this.#text, node.getFullStart());
    const line = this.line(comments?.[0]?.pos ?? node.getStart(this.#source));
    this.#starts.set(node, line);
    return line;
  }

  endLine(node: ts.Node): number {
    return this.line(Math.max(node.getStart(this.#source), node.getEnd() - 1));
  }

  oversized(startLine: number, endLine: number): boolean {
    return this.#snapshot.rangeTokens(startLine, endLine) > this.#limits.maxTokens
      || this.#snapshot.rangeBytes(startLine, endLine) > this.#limits.maxBytes
      || endLine - startLine + 1 > this.#limits.maxLines;
  }

  fitsTarget(startLine: number, endLine: number): boolean {
    return this.#snapshot.rangeTokens(startLine, endLine) <= this.#limits.targetTokens
      && this.#snapshot.rangeBytes(startLine, endLine) <= this.#limits.maxBytes
      && endLine - startLine + 1 <= this.#limits.maxLines;
  }

  fitsHard(startLine: number, endLine: number): boolean {
    return !this.oversized(startLine, endLine);
  }

  tokens(startLine: number, endLine: number): number {
    return this.#snapshot.rangeTokens(startLine, endLine);
  }

  children(node: ts.Node): ts.Node[] {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      if (child.kind !== ts.SyntaxKind.EndOfFileToken) children.push(child);
    });
    return children;
  }

  /** Partition `[startLine, endLine]` at the start lines of `node`'s children. */
  units(node: ts.Node, startLine: number, endLine: number): Unit[] {
    const units: Unit[] = [{ startLine, endLine, nodes: [] }];
    for (const child of this.children(node)) {
      const start = this.startLine(child);
      const last = units[units.length - 1]!;
      if (start > last.startLine && start <= endLine) {
        last.endLine = start - 1;
        units.push({ startLine: start, endLine, nodes: [child] });
      } else {
        last.nodes.push(child);
      }
    }
    return units;
  }

  /** The child that spans the most lines; the one an oversized unit descends into. */
  widest(nodes: readonly ts.Node[]): ts.Node | null {
    let best: ts.Node | null = null;
    let span = -1;
    for (const node of nodes) {
      const current = this.endLine(node) - this.startLine(node);
      if (current > span) {
        best = node;
        span = current;
      }
    }
    return best;
  }

  nameOf(node: ts.Node | undefined): string | null {
    if (node === undefined) return null;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
      return bounded(node.text, MAX_NAME_CHARACTERS);
    }
    return bounded(compress(node.getText(this.#source)), MAX_NAME_CHARACTERS);
  }

  signatureOf(node: ts.SignatureDeclaration): string {
    const parameters = node.parameters.map((parameter) => compress(parameter.getText(this.#source))).join(', ');
    return `(${bounded(parameters, MAX_SIGNATURE_CHARACTERS)})`;
  }

  containsJsx(root: ts.Node): boolean {
    const stack: ts.Node[] = [root];
    let visited = 0;
    while (stack.length > 0 && visited < 50_000) {
      const node = stack.pop()!;
      visited += 1;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
      ts.forEachChild(node, (child) => { stack.push(child); });
    }
    return false;
  }

  functionSymbol(holder: ts.Node, name: string, fn: ts.SignatureDeclaration): SymbolInfo {
    const component = /^[A-Z]/.test(name) && this.containsJsx(fn);
    return this.symbol(holder, component ? 'component' : 'function', name, this.signatureOf(fn));
  }

  symbol(node: ts.Node, kind: string, name: string, signature: string | null): SymbolInfo {
    return { kind, name, signature, startLine: this.startLine(node), endLine: this.endLine(node) };
  }

  /** A function wrapped by a call, as in `memo(() => …)` or `forwardRef(function (…) {…})`. */
  wrappedFunction(node: ts.Expression | undefined): ts.ArrowFunction | ts.FunctionExpression | null {
    if (isFunctionLike(node)) return node;
    if (node !== undefined && ts.isCallExpression(node)) {
      const inner = node.arguments.find(isFunctionLike);
      return inner ?? null;
    }
    return null;
  }

  /** A named holder (`const x =`, `a.b =`, `key:`) labels the value it initializes. */
  initializerSymbol(holder: ts.Node, name: string | null, value: ts.Expression | undefined, multiline: boolean): SymbolInfo | null {
    if (name === null || value === undefined) return null;
    const fn = this.wrappedFunction(value);
    if (fn !== null) return this.functionSymbol(holder, fn.name?.text ?? name, fn);
    if (ts.isClassExpression(value)) return this.symbol(holder, 'class', name, null);
    if (multiline && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isCallExpression(value)
      || ts.isNewExpression(value))) {
      return this.symbol(holder, ts.isObjectLiteralExpression(value) ? 'object' : 'variable', name, null);
    }
    return null;
  }

  /** True when a function or call is the value of a holder that already names it. */
  hasNamedHolder(node: ts.Node): boolean {
    let current = node;
    let parent = node.parent as ts.Node | undefined;
    if (parent !== undefined && ts.isCallExpression(parent) && isFunctionLike(current)) {
      current = parent;
      parent = parent.parent as ts.Node | undefined;
    }
    if (parent === undefined) return false;
    return ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
      && parent.initializer === current)
      || (ts.isBinaryExpression(parent) && parent.right === current && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      || (ts.isExportAssignment(parent) && parent.expression === current);
  }

  calleeText(expression: ts.Expression): string {
    const text = expression.getText(this.#source);
    if (!text.includes('\n')) return bounded(compress(text), MAX_NAME_CHARACTERS);
    return ts.isPropertyAccessExpression(expression) ? `….${expression.name.text}` : bounded(compress(text), MAX_NAME_CHARACTERS);
  }

  /** The structural symbol a node introduces, if any. */
  symbolOf(node: ts.Node): SymbolInfo | null {
    const multiline = this.endLine(node) > this.startLine(node);
    if (ts.isFunctionDeclaration(node)) return this.functionSymbol(node, node.name?.text ?? 'default', node);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return ts.isClassExpression(node) && node.name === undefined && this.hasNamedHolder(node)
        ? null : this.symbol(node, 'class', node.name?.text ?? 'default', null);
    }
    if (ts.isInterfaceDeclaration(node)) return this.symbol(node, 'interface', node.name.text, null);
    if (ts.isTypeAliasDeclaration(node)) return this.symbol(node, 'type', node.name.text, null);
    if (ts.isEnumDeclaration(node)) return this.symbol(node, 'enum', node.name.text, null);
    if (ts.isModuleDeclaration(node)) return this.symbol(node, 'namespace', this.nameOf(node.name) ?? 'namespace', null);
    if (ts.isConstructorDeclaration(node)) return this.symbol(node, 'method', 'constructor', this.signatureOf(node));
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      return this.symbol(node, 'method', this.nameOf(node.name) ?? 'method', this.signatureOf(node));
    }
    if (ts.isGetAccessorDeclaration(node)) return this.symbol(node, 'getter', this.nameOf(node.name) ?? 'get', null);
    if (ts.isSetAccessorDeclaration(node)) return this.symbol(node, 'setter', this.nameOf(node.name) ?? 'set', this.signatureOf(node));
    if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
      const symbol = this.initializerSymbol(node, this.nameOf(node.name), node.initializer, multiline);
      return symbol !== null && symbol.kind === 'function' ? { ...symbol, kind: 'method' } : symbol;
    }
    if (ts.isVariableStatement(node)) {
      const [declaration] = node.declarationList.declarations;
      if (declaration === undefined || !ts.isIdentifier(declaration.name)) return null;
      return this.initializerSymbol(node, declaration.name.text, declaration.initializer, multiline);
    }
    if (ts.isExportAssignment(node)) return this.initializerSymbol(node, 'default', node.expression, multiline);
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return this.initializerSymbol(node, this.nameOf(node.expression.left), node.expression.right, multiline);
    }
    if (ts.isFunctionExpression(node) && node.name !== undefined && !this.hasNamedHolder(node)) {
      return this.functionSymbol(node, node.name.text, node);
    }
    if (ts.isCallExpression(node) && node.arguments.some(isFunctionLike) && !this.hasNamedHolder(node)) {
      const first = node.arguments[0];
      const detail = first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
        ? `(${JSON.stringify(bounded(first.text, 60))})` : '';
      return this.symbol(node, 'callback', `${this.calleeText(node.expression)}${detail}`, null);
    }
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && multiline) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      return this.symbol(node, 'element', this.nameOf(tag) ?? 'element', null);
    }
    if (ts.isCaseClause(node) && multiline) {
      return this.symbol(node, 'case', bounded(compress(node.expression.getText(this.#source)), 60), null);
    }
    return null;
  }

  /** The symbol a unit starts with: the first node's own symbol or one of its leading wrappers'. */
  ownSymbol(unit: Unit): SymbolInfo | null {
    let node: ts.Node | null = unit.nodes[0] ?? null;
    const start = node === null ? 0 : this.startLine(node);
    for (let depth = 0; node !== null && depth < 6; depth += 1) {
      const symbol = this.symbolOf(node);
      if (symbol !== null) return symbol;
      node = this.widest(this.children(node).filter((child) => this.startLine(child) === start));
    }
    return null;
  }

  /** Split `node`, whose lines are `[startLine, endLine]`, into chunks under the limits. */
  plan(node: ts.Node, startLine: number, endLine: number, ancestry: readonly SymbolInfo[], depth: number,
    damaged?: (startLine: number, endLine: number) => boolean): Chunk[] {
    const symbol = node.kind === ts.SyntaxKind.SourceFile ? null : this.symbolOf(node);
    const context = symbol === null ? ancestry : [...ancestry, symbol];
    const leaf = (): Chunk[] => [{ startLine, endLine, ancestry: context, own: null, windows: true }];
    if (depth > MAX_DEPTH) return leaf();

    const units = this.units(node, startLine, endLine);
    if (damaged !== undefined && units.length === 1 && damaged(startLine, endLine)) {
      return [{ startLine, endLine, ancestry: [], own: null, windows: true, damaged: true }];
    }
    if (units.length === 1) {
      // Every child starts on the first line: descend through the wrapper that holds the rest.
      const inner = this.widest(units[0]!.nodes);
      return inner === null ? leaf() : this.plan(inner, startLine, endLine, context, depth + 1);
    }

    const chunks: Chunk[] = [];
    let pending: Chunk | null = null;
    const flush = (): void => {
      if (pending !== null) chunks.push(pending);
      pending = null;
    };
    for (const unit of units) {
      if (damaged?.(unit.startLine, unit.endLine) === true) {
        flush();
        chunks.push({ startLine: unit.startLine, endLine: unit.endLine, ancestry: [], own: null, windows: true, damaged: true });
        continue;
      }
      if (this.oversized(unit.startLine, unit.endLine)) {
        let start = unit.startLine;
        const header: Chunk | null = pending;
        if (header !== null && header.own === null && this.tokens(header.startLine, header.endLine) <= HEADER_TOKENS) {
          start = header.startLine;
          pending = null;
        } else {
          flush();
        }
        const inner = this.widest(unit.nodes);
        chunks.push(...(inner === null
          ? [{ startLine: start, endLine: unit.endLine, ancestry: context, own: null, windows: true }]
          : this.plan(inner, start, unit.endLine, context, depth + 1)));
        continue;
      }
      const current: Chunk | null = pending;
      if (current !== null && this.fitsTarget(current.startLine, unit.endLine)) {
        current.endLine = unit.endLine;
        current.own ??= this.ownSymbol(unit);
        continue;
      }
      flush();
      pending = { startLine: unit.startLine, endLine: unit.endLine, ancestry: context, own: this.ownSymbol(unit), windows: false };
    }
    flush();
    return chunks;
  }

  /** Fold tiny structural remnants (`return dom; }`, a lone header) into a contiguous neighbour. */
  mergeTiny(chunks: Chunk[]): Chunk[] {
    const result: Chunk[] = [];
    for (const chunk of chunks) {
      const previous = result[result.length - 1];
      if (previous !== undefined && !previous.windows && !chunk.windows && previous.endLine + 1 === chunk.startLine
        && (this.tokens(chunk.startLine, chunk.endLine) <= TINY_TOKENS || this.tokens(previous.startLine, previous.endLine) <= TINY_TOKENS)
        && this.fitsHard(previous.startLine, chunk.endLine)) {
        result[result.length - 1] = {
          startLine: previous.startLine, endLine: chunk.endLine, ancestry: commonAncestry(previous.ancestry, chunk.ancestry),
          own: previous.own ?? chunk.own, windows: false,
        };
        continue;
      }
      result.push(chunk);
    }
    return result;
  }
}

function commonAncestry(left: readonly SymbolInfo[], right: readonly SymbolInfo[]): readonly SymbolInfo[] {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return left.slice(0, length);
}

function render(symbol: SymbolInfo, withSignature: boolean): string {
  return `${symbol.kind}:${symbol.name}${withSignature && symbol.signature !== null ? symbol.signature : ''}`;
}

/** Enclosing symbols, outermost first, then the first symbol the range declares. */
function enclosingLabel(chunk: Chunk): string | null {
  const parts: string[] = [];
  const symbols = chunk.own !== null && !chunk.ancestry.includes(chunk.own) ? [...chunk.ancestry, chunk.own] : [...chunk.ancestry];
  for (const symbol of symbols) {
    const partial = symbol.startLine < chunk.startLine || symbol.endLine > chunk.endLine;
    parts.push(`${render(symbol, true)}${partial ? ` [lines ${String(symbol.startLine)}-${String(symbol.endLine)}]` : ''}`);
  }
  if (parts.length === 0) return null;
  let label = parts.join(' > ');
  // Keep the outermost and innermost symbols; elide the middle of a deep chain.
  while (label.length > MAX_LABEL_CHARACTERS && parts.length > 3) {
    if (parts[1] === '…') parts.splice(2, 1);
    else parts.splice(1, 1, '…');
    label = parts.join(' > ');
  }
  return bounded(label, MAX_LABEL_CHARACTERS);
}

/** Enclosing symbol names only: no signatures and no line spans. */
function compactLabel(chunk: Chunk): string | null {
  const symbols = chunk.own !== null && !chunk.ancestry.includes(chunk.own) ? [...chunk.ancestry, chunk.own] : [...chunk.ancestry];
  if (symbols.length === 0) return null;
  const parts = symbols.map((symbol) => render(symbol, false));
  let label = parts.join(' > ');
  while (label.length > MAX_LABEL_CHARACTERS && parts.length > 3) {
    if (parts[1] === '…') parts.splice(2, 1);
    else parts.splice(1, 1, '…');
    label = parts.join(' > ');
  }
  return bounded(label, MAX_LABEL_CHARACTERS);
}

/** The previous convention: the outermost symbol that starts inside the range, without context. */
function localLabel(chunk: Chunk): string | null {
  const starting = [...chunk.ancestry, ...(chunk.own === null ? [] : [chunk.own])]
    .find((symbol) => symbol.startLine >= chunk.startLine && symbol.startLine <= chunk.endLine);
  return starting === undefined ? null : bounded(render(starting, false), 160);
}

/**
 * Plan the fragments of one JS/TS snapshot. Pure and deterministic; nothing from the
 * repository is resolved, compiled or executed.
 */
export function planJavaScriptRanges(
  snapshot: SourceSnapshot,
  limits: WindowLimits,
  policy: JavaScriptContextPolicy = 'local',
): JavaScriptPlan {
  try {
    const source = ts.createSourceFile(snapshot.relativePath, snapshot.text, ts.ScriptTarget.Latest, true, scriptKindOf(snapshot.relativePath));
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (!Array.isArray(diagnostics)) return { ok: false, reason: 'parse_failure' };
    const planner = new Planner(snapshot, source, limits);
    const damagedLines = [...new Set(diagnostics.map((diagnostic) => planner.line(Math.min(diagnostic.start ?? 0, snapshot.text.length))))];
    const damaged = damagedLines.length === 0 ? undefined
      : (startLine: number, endLine: number): boolean => damagedLines.some((line) => line >= startLine && line <= endLine);

    const chunks = planner.mergeTiny(planner.plan(source, 1, snapshot.lineCount, [], 0, damaged));
    if (damaged !== undefined) {
      const lines = chunks.filter((chunk) => chunk.damaged === true)
        .reduce((sum, chunk) => sum + chunk.endLine - chunk.startLine + 1, 0);
      if (lines > snapshot.lineCount * MAX_RECOVERED_SHARE) return { ok: false, reason: 'parse_failure' };
    }
    const labelOf = policy === 'enclosing' ? enclosingLabel : policy === 'compact' ? compactLabel : localLabel;
    return {
      ok: true,
      recovered: damaged !== undefined,
      ranges: chunks.map((chunk) => ({
        startLine: chunk.startLine, endLine: chunk.endLine, windows: chunk.windows,
        label: labelOf(chunk), labelEveryWindow: policy !== 'local',
      })),
    };
  } catch {
    // Excessively nested or otherwise unparseable input stays searchable through windows.
    return { ok: false, reason: 'parse_failure' };
  }
}
