/**
 * Depth-indexed statement boundaries for Go and Rust, the `jevgrep-tree-sitter-*-3`
 * policy. Production plans Go and Rust with the shared recursive planner
 * (`tree-sitter-chunker.ts`); these boundaries feed `chunkWithBoundaries` only in the
 * `go-rust-boundaries` benchmark arm. A tree with any error or missing node is a parse
 * failure, so the caller falls back to line windows.
 *
 * Depths match the other syntax chunkers: top-level items are depth 0, members of
 * containers (impl/trait/mod bodies) and statements of top-level functions depth 1,
 * statements of member functions depth 2. Own-line comments directly above an item stay
 * attached to it; Rust attributes (`#[...]`, `#![...]`) always attach to the next item,
 * together with the comments directly above them. Go function literals held by a `var`,
 * `go` or `defer` statement are refined like function bodies.
 *
 * Labels come from the language profiles (`language-profiles.ts`).
 */
import type { Node } from 'web-tree-sitter';

import type { Boundary, ParseOutcome } from './javascript-boundaries.ts';
import { LANGUAGE_PROFILES } from './language-profiles.ts';
import type { TreeSitterProfile } from './language-profiles.ts';
import { parserFor } from './tree-sitter-parser.ts';
import type { TreeSitterLanguage } from './tree-sitter-parser.ts';

export { TREE_SITTER_GRAMMARS } from './tree-sitter-parser.ts';
export type { TreeSitterLanguage };

type LanguageRules = {
  /** Node types whose comment children attach to the next item. */
  readonly comments: ReadonlySet<string>;
  /** Node types that always attach to the next item, with the comments directly above them. */
  readonly attributes: ReadonlySet<string>;
  /** The body whose named children are the next depth, for nodes that have one. */
  readonly bodyOf: (node: Node) => Node | null;
  readonly label: (node: Node) => string | null;
};

const bodyField = (node: Node): Node | null => node.childForFieldName('body');

/** The function literal of `var h = func…` (grouped or not), `go func(){…}()` or `defer func(){…}()`. */
function goFuncLiteral(node: Node): Node | null {
  if (node.type === 'var_declaration') {
    const specs = node.namedChildren.flatMap((child) => (child?.type === 'var_spec_list' ? child.namedChildren : [child]))
      .filter((child) => child?.type === 'var_spec');
    const values = specs.length === 1 ? specs[0]!.childForFieldName('value')?.namedChildren ?? [] : [];
    return values.length === 1 && values[0]?.type === 'func_literal' ? values[0] : null;
  }
  const call = node.namedChildren[0];
  const callee = call?.type === 'call_expression' ? call.childForFieldName('function') : null;
  return callee?.type === 'func_literal' ? callee : null;
}

function rulesOf(profile: TreeSitterProfile, bodyOf: (node: Node) => Node | null): LanguageRules {
  return {
    ...profile.leading,
    bodyOf,
    label: (node) => {
      const symbol = profile.label(node);
      return symbol === null ? null : `${symbol.kind}:${symbol.name}`;
    },
  };
}

const profileOf = (language: TreeSitterLanguage): TreeSitterProfile => LANGUAGE_PROFILES[language] as TreeSitterProfile;

const RULES: Readonly<Record<TreeSitterLanguage, LanguageRules>> = {
  go: rulesOf(profileOf('go'), (node) => {
    switch (node.type) {
      case 'function_declaration': case 'method_declaration': return bodyField(node);
      case 'var_declaration': case 'go_statement': case 'defer_statement': {
        const literal = goFuncLiteral(node);
        return literal === null ? null : bodyField(literal);
      }
      default: return null;
    }
  }),
  rust: rulesOf(profileOf('rust'), (node) => (['function_item', 'impl_item', 'trait_item', 'mod_item'].includes(node.type) ? bodyField(node) : null)),
};

const MAX_DEPTH = 2;

/** Go wraps block statements in a `statement_list` node, next to any comment that opens the block. */
function statementsOf(body: Node): readonly (Node | null)[] {
  return body.namedChildren.flatMap((child) => (child?.type === 'statement_list' ? child.namedChildren : [child]));
}

function collect(nodes: readonly (Node | null)[], depth: number, rules: LanguageRules, out: Boundary[]): void {
  let leading: Node | null = null;
  // An attribute in the run pins it to the next item across blank lines.
  let pinned = false;
  let lastEnd = -2;
  let lastItemEnd = -2;
  for (const node of nodes) {
    if (node === null) continue;
    const startRow = node.startPosition.row;
    if (rules.attributes.has(node.type)) {
      if (leading === null || (!pinned && startRow > lastEnd + 1)) leading = node;
      pinned = true;
      lastEnd = node.endPosition.row;
      continue;
    }
    if (rules.comments.has(node.type)) {
      // A comment on the line where the previous item ends trails that item.
      if (!pinned && startRow !== lastItemEnd && (leading === null || startRow > lastEnd + 1)) leading = node;
      lastEnd = node.endPosition.row;
      continue;
    }
    const attached = leading !== null && (pinned || startRow <= lastEnd + 1) ? leading : null;
    out.push({ line: (attached ?? node).startPosition.row + 1, depth, label: rules.label(node) });
    leading = null;
    pinned = false;
    lastEnd = lastItemEnd = node.endPosition.row;
    if (depth < MAX_DEPTH) {
      const body = rules.bodyOf(node);
      if (body !== null) collect(statementsOf(body), depth + 1, rules, out);
    }
  }
}

export function parseTreeSitterBoundaries(language: TreeSitterLanguage, text: string): ParseOutcome {
  const tree = parserFor(language).parse(text);
  if (tree === null) return { ok: false, reason: 'parse_failure' };
  try {
    const root = tree.rootNode;
    if (root.hasError) return { ok: false, reason: 'parse_failure' };
    const found: Boundary[] = [];
    collect(root.namedChildren, 0, RULES[language], found);
    const seen = new Set<string>();
    const boundaries = found.filter((boundary) => {
      const key = `${String(boundary.depth)}:${String(boundary.line)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    boundaries.sort((a, b) => a.line - b.line || a.depth - b.depth);
    return { ok: true, boundaries };
  } finally {
    tree.delete();
  }
}
