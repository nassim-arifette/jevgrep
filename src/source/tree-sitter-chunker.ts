/**
 * Tree-sitter adapter of the shared recursive planner (`syntax-planner.ts`) for Go and Rust.
 *
 * A node's children are its named children, without the leading trivia of the profile:
 * own-line comments directly above a node, and attributes with the comments directly
 * above them, start the node they precede. A comment on the line where the previous
 * node ends trails that node. Trivia that precedes no node stays inside the lines of
 * its parent, so no line is ever dropped.
 *
 * Error and missing nodes mark damaged lines: a top-level item holding one becomes line
 * windows and the rest of the file keeps its structure (LS-8).
 */
import type { Node } from 'web-tree-sitter';

import type { TreeSitterProfile } from './language-profiles.ts';
import type { WindowLimits } from './line-windows.ts';
import type { SourceSnapshot } from './snapshot.ts';
import { planSyntaxRanges } from './syntax-planner.ts';
import type { PlanSymbol, SyntaxPlan, SyntaxTree } from './syntax-planner.ts';
import { parserFor } from './tree-sitter-parser.ts';

type Item = { readonly node: Node; readonly startLine: number };

/** A Tree-sitter tree as the planner sees it; valid only while the tree is alive. */
class TreeSitterTree implements SyntaxTree<Item> {
  readonly root: Item;
  readonly #profile: TreeSitterProfile;
  readonly #children = new Map<number, readonly Item[]>();

  constructor(root: Node, profile: TreeSitterProfile) {
    this.root = { node: root, startLine: 1 };
    this.#profile = profile;
  }

  children(item: Item): readonly Item[] {
    const cached = this.#children.get(item.node.id);
    if (cached !== undefined) return cached;
    const { comments, attributes } = this.#profile.leading;
    const items: Item[] = [];
    let leading: Node | null = null;
    // An attribute in the run pins it to the next node across blank lines.
    let pinned = false;
    let lastEnd = -2;
    let lastItemEnd = -2;
    for (const node of item.node.namedChildren) {
      if (node === null) continue;
      const startRow = node.startPosition.row;
      if (attributes.has(node.type)) {
        if (leading === null || (!pinned && startRow > lastEnd + 1)) leading = node;
        pinned = true;
        lastEnd = node.endPosition.row;
        continue;
      }
      if (comments.has(node.type)) {
        if (!pinned && startRow !== lastItemEnd && (leading === null || startRow > lastEnd + 1)) leading = node;
        lastEnd = node.endPosition.row;
        continue;
      }
      const attached = leading !== null && (pinned || startRow <= lastEnd + 1) ? leading : null;
      items.push({ node, startLine: (attached ?? node).startPosition.row + 1 });
      leading = null;
      pinned = false;
      lastEnd = lastItemEnd = node.endPosition.row;
    }
    this.#children.set(item.node.id, items);
    return items;
  }

  startLine(item: Item): number {
    return item.startLine;
  }

  endLine(item: Item): number {
    return item.node.endPosition.row + 1;
  }

  symbolOf(item: Item): PlanSymbol | null {
    const symbol = this.#profile.label(item.node);
    return symbol === null ? null : { ...symbol, signature: null, startLine: item.startLine, endLine: this.endLine(item) };
  }
}

/** Lines holding an error or missing node; empty for a clean tree. */
function damagedLinesOf(root: Node): number[] {
  const lines = new Set<number>();
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      lines.add(node.startPosition.row + 1);
      lines.add(node.endPosition.row + 1);
      continue;
    }
    if (!node.hasError) continue;
    for (const child of node.children) {
      if (child !== null) stack.push(child);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Plan the fragments of one Go or Rust snapshot. Pure and deterministic; nothing from
 * the repository is resolved, compiled or executed.
 */
export function planTreeSitterRanges(snapshot: SourceSnapshot, limits: WindowLimits, profile: TreeSitterProfile): SyntaxPlan {
  const tree = parserFor(profile.parser.grammar).parse(snapshot.text);
  if (tree === null) return { ok: false, reason: 'parse_failure' };
  try {
    const root = tree.rootNode;
    return planSyntaxRanges(snapshot, new TreeSitterTree(root, profile), limits, {
      policy: 'local', declarationKinds: profile.declarations, damagedLines: damagedLinesOf(root), firstUnitLabels: true,
      mergeWithinDeclarations: true,
    });
  } finally {
    tree.delete();
  }
}
