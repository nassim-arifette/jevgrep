/**
 * Tree-sitter adapter of the shared recursive planner (`syntax-planner.ts`) for Go and Rust.
 *
 * A node's children are its named children, without the leading trivia of the profile:
 * own-line comments directly above a node, and attributes with the comments directly
 * above them, start the node they precede. A comment on the line where the previous
 * node ends trails that node. Trivia that precedes no node stays inside the lines of
 * its parent, so no line is ever dropped.
 * An oversized node is split between the comments above it, so a long doc comment
 * becomes fragments of its own while attributes stay on the node they precede.
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

/**
 * A node with the leading trivia attached to it. `tail` marks the node itself, without
 * the comments above its attributes, once its trivia has been split off.
 */
type Item = { readonly node: Node; readonly startLine: number; readonly leading: readonly Node[]; readonly tail?: true };

/** Last row of a node; a line comment ends at column 0 of the next row, after its newline. */
function endRow(node: Node): number {
  const end = node.endPosition;
  return end.column === 0 && end.row > node.startPosition.row ? end.row - 1 : end.row;
}

/** A Tree-sitter tree as the planner sees it; valid only while the tree is alive. */
class TreeSitterTree implements SyntaxTree<Item> {
  readonly root: Item;
  readonly #profile: TreeSitterProfile;
  readonly #children = new Map<Item, readonly Item[]>();

  constructor(root: Node, profile: TreeSitterProfile) {
    this.root = { node: root, startLine: 1, leading: [] };
    this.#profile = profile;
  }

  children(item: Item): readonly Item[] {
    const cached = this.#children.get(item);
    if (cached !== undefined) return cached;
    const items = item.leading.length > 0 ? this.#triviaChildren(item) : this.#nodeChildren(item.node);
    this.#children.set(item, items);
    return items;
  }

  /**
   * An oversized node with leading trivia splits between its comments: each comment above
   * its last attribute group is a child, then that group stays with the node it precedes.
   */
  #triviaChildren(item: Item): Item[] {
    const { attributes } = this.#profile.leading;
    // The last attribute group and the comments below it stay with the node.
    let tail = item.leading.length;
    let attributed = false;
    for (let index = item.leading.length - 1; index >= 0; index -= 1) {
      const isAttribute = attributes.has(item.leading[index]!.type);
      if (!isAttribute && attributed) break;
      attributed ||= isAttribute;
      if (attributed) tail = index;
    }
    const items: Item[] = item.leading.slice(0, tail).map((node) => ({ node, startLine: node.startPosition.row + 1, leading: [] }));
    items.push({ node: item.node, startLine: (item.leading[tail] ?? item.node).startPosition.row + 1, leading: [], tail: true });
    return items;
  }

  #nodeChildren(parent: Node): Item[] {
    const { comments, attributes } = this.#profile.leading;
    const items: Item[] = [];
    let run: Node[] = [];
    // An attribute in the run pins it to the next node across blank lines.
    let pinned = false;
    let lastEnd = -2;
    let lastItemEnd = -2;
    for (const node of parent.namedChildren) {
      if (node === null) continue;
      const startRow = node.startPosition.row;
      if (attributes.has(node.type)) {
        if (run.length === 0 || (!pinned && startRow > lastEnd + 1)) run = [];
        run.push(node);
        pinned = true;
        lastEnd = endRow(node);
        continue;
      }
      if (comments.has(node.type)) {
        if (!pinned && startRow !== lastItemEnd && (run.length === 0 || startRow > lastEnd + 1)) run = [];
        if (pinned || startRow !== lastItemEnd || run.length > 0) run.push(node);
        lastEnd = endRow(node);
        continue;
      }
      const leading = run.length > 0 && (pinned || startRow <= lastEnd + 1) ? run : [];
      items.push({ node, startLine: (leading[0] ?? node).startPosition.row + 1, leading });
      run = [];
      pinned = false;
      lastEnd = lastItemEnd = endRow(node);
    }
    return items;
  }

  startLine(item: Item): number {
    return item.startLine;
  }

  endLine(item: Item): number {
    return endRow(item.node) + 1;
  }

  symbolOf(item: Item): PlanSymbol | null {
    if (item.tail === true) return null;
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
