/** Syntax-only boundaries from a separately pinned TypeScript compiler API. */
import ts from 'typescript-parser';

export type Boundary = {
  readonly line: number;
  /** Top-level statements are depth 0; members and block statements refine them. */
  readonly depth: number;
  readonly label: string | null;
};

export type ParseOutcome =
  | { readonly ok: true; readonly boundaries: readonly Boundary[] }
  | { readonly ok: false; readonly reason: 'parse_failure' };

function labelOf(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return `function:${node.name?.text ?? 'default'}`;
  if (ts.isClassDeclaration(node)) return `class:${node.name?.text ?? 'default'}`;
  if (ts.isInterfaceDeclaration(node)) return `interface:${node.name.text}`;
  if (ts.isTypeAliasDeclaration(node)) return `type:${node.name.text}`;
  if (ts.isEnumDeclaration(node)) return `enum:${node.name.text}`;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return `method:${node.name.text}`;
  return null;
}

/**
 * Parse only the supplied text. No Program, host, module resolution, plugin or
 * printer is created. UTF-16 offsets are mapped by the retained source snapshot.
 * The pinned API's parser diagnostics are inspected without any type checking.
 */
export function parseJavaScriptBoundaries(
  text: string,
  lineOfOffset: (offset: number) => number,
  path: string,
): ParseOutcome {
  try {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    const kind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX
      : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (!Array.isArray(diagnostics) || diagnostics.length > 0) return { ok: false, reason: 'parse_failure' };

    const boundaries: Boundary[] = [];
    const seen = new Set<string>();
    // An explicit stack also handles deep expression trees without a recursive visitor.
    const stack: { node: ts.Node; depth: number; member: boolean }[] = [{ node: source, depth: 0, member: false }];
    while (stack.length > 0) {
      const { node, depth, member } = stack.pop()!;
      if (depth > 2) continue;
      if ((ts.isStatement(node) && !ts.isBlock(node)) || member) {
        const comments = ts.getLeadingCommentRanges(text, node.getFullStart());
        const start = comments?.[0]?.pos ?? node.getStart(source);
        const line = lineOfOffset(start);
        const key = `${depth}:${line}`;
        if (!seen.has(key)) {
          seen.add(key);
          boundaries.push({ line, depth, label: labelOf(node)?.slice(0, 160) ?? null });
        }
      }
      const members = ts.isClassLike(node) || ts.isInterfaceDeclaration(node);
      const memberNodes = new Set<ts.Node>(members ? node.members : []);
      const childDepth = depth + (members || ts.isBlock(node) || ts.isModuleBlock(node) ? 1 : 0);
      ts.forEachChild(node, (child) => {
        const member = memberNodes.has(child);
        stack.push({ node: child, depth: childDepth, member });
      });
    }
    boundaries.sort((a, b) => a.line - b.line || a.depth - b.depth);
    return { ok: true, boundaries };
  } catch {
    // Malformed or excessively nested source remains searchable through windows.
    return { ok: false, reason: 'parse_failure' };
  }
}
