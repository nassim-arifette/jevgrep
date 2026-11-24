/**
 * JS/TS adapter of the shared recursive planner (`syntax-planner.ts`, roadmap section 7,
 * experiment E1).
 *
 * The pinned TypeScript parser supplies the tree: a node's children are its AST children
 * and its first line includes the comments and decorators that precede it.
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
import { JAVASCRIPT_PROFILE } from './language-profiles.ts';
import { bounded, planSyntaxRanges } from './syntax-planner.ts';
import type { LabelPolicy, PlanSymbol, PlannedRange, SyntaxPlan, SyntaxTree } from './syntax-planner.ts';

export type JavaScriptContextPolicy = LabelPolicy;
export type { PlannedRange };
export type JavaScriptPlan = SyntaxPlan;

type SymbolInfo = PlanSymbol;

const MAX_NAME_CHARACTERS = 80;
const MAX_SIGNATURE_CHARACTERS = 120;

function scriptKindOf(path: string): ts.ScriptKind {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  return ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

const compress = (text: string): string => text.replace(/\s+/g, ' ').trim();

const isFunctionLike = (node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** The TypeScript compiler tree of one file, as the planner sees it. */
class TypeScriptTree implements SyntaxTree<ts.Node> {
  readonly root: ts.Node;
  readonly #snapshot: SourceSnapshot;
  readonly #source: ts.SourceFile;
  readonly #text: string;
  readonly #starts = new Map<ts.Node, number>();

  constructor(snapshot: SourceSnapshot, source: ts.SourceFile) {
    this.root = source;
    this.#snapshot = snapshot;
    this.#source = source;
    this.#text = snapshot.text;
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

  children(node: ts.Node): ts.Node[] {
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      if (child.kind !== ts.SyntaxKind.EndOfFileToken) children.push(child);
    });
    return children;
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
    const tree = new TypeScriptTree(snapshot, source);
    const damagedLines = [...new Set(diagnostics.map((diagnostic) => tree.line(Math.min(diagnostic.start ?? 0, snapshot.text.length))))];
    return planSyntaxRanges(snapshot, tree, limits, { policy, declarationKinds: JAVASCRIPT_PROFILE.declarations, damagedLines });
  } catch {
    // Excessively nested or otherwise unparseable input stays searchable through windows.
    return { ok: false, reason: 'parse_failure' };
  }
}
