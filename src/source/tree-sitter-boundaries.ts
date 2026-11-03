/**
 * Statement boundaries for Go and Rust from pinned Tree-sitter grammars (WASM).
 *
 * Tree-sitter only parses the supplied text: nothing is imported, compiled or run, and
 * no native addon is loaded. The grammars are vendored `.wasm` files (MIT, see the
 * LICENSE files next to them) so installing JevGrep runs no install script. A tree with
 * any error or missing node is a parse failure, so the caller falls back to line windows.
 *
 * Depths match the other syntax chunkers: top-level items are depth 0, members of
 * containers (impl/trait/mod bodies) and statements of top-level functions depth 1,
 * statements of member functions depth 2. Own-line comments directly above an item stay
 * attached to it.
 */
import { readFileSync } from 'node:fs';
import { Language, Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';

import type { Boundary, ParseOutcome } from './javascript-boundaries.ts';

export type TreeSitterLanguage = 'go' | 'rust';

/** Grammar package versions of the vendored WASM files; part of the chunker version. */
export const TREE_SITTER_GRAMMARS: Readonly<Record<TreeSitterLanguage, string>> = {
  go: 'tree-sitter-go-0.25.0',
  rust: 'tree-sitter-rust-0.24.0',
};

type LanguageRules = {
  /** Node types whose comment children attach to the next item. */
  readonly comments: ReadonlySet<string>;
  /** Item type → field holding the body whose named children are the next depth. */
  readonly bodies: Readonly<Record<string, string>>;
  readonly label: (node: Node) => string | null;
};

const nameOf = (node: Node): string | null => node.childForFieldName('name')?.text ?? null;
const labelled = (kind: string, name: string | null): string | null => (name === null ? null : `${kind}:${name}`);

const RULES: Readonly<Record<TreeSitterLanguage, LanguageRules>> = {
  go: {
    comments: new Set(['comment']),
    bodies: { function_declaration: 'body', method_declaration: 'body', func_literal: 'body' },
    label: (node) => {
      switch (node.type) {
        case 'function_declaration': return labelled('function', nameOf(node));
        case 'method_declaration': return labelled('method', nameOf(node));
        case 'type_declaration': {
          const spec = node.namedChildren.find((child) => child?.type === 'type_spec' || child?.type === 'type_alias');
          return spec === undefined || spec === null ? null : labelled('type', nameOf(spec));
        }
        default: return null;
      }
    },
  },
  rust: {
    comments: new Set(['line_comment', 'block_comment']),
    bodies: { function_item: 'body', impl_item: 'body', trait_item: 'body', mod_item: 'body' },
    label: (node) => {
      switch (node.type) {
        case 'function_item': return labelled('function', nameOf(node));
        case 'struct_item': return labelled('struct', nameOf(node));
        case 'enum_item': return labelled('enum', nameOf(node));
        case 'trait_item': return labelled('trait', nameOf(node));
        case 'mod_item': return labelled('mod', nameOf(node));
        case 'type_item': return labelled('type', nameOf(node));
        case 'impl_item': return labelled('impl', node.childForFieldName('type')?.text ?? null);
        default: return null;
      }
    },
  },
};

const MAX_DEPTH = 2;

await Parser.init();
const grammarUrl = (language: TreeSitterLanguage): URL => new URL(`./grammars/tree-sitter-${language}.wasm`, import.meta.url);
const parsers = new Map<TreeSitterLanguage, Parser>();
// Node's global WebAssembly is not in this project's type libraries.
const WasmModule = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => unknown } }).WebAssembly.Module;

/** Grammars compile on first use, so a scope without Go or Rust never loads one. */
function parserFor(language: TreeSitterLanguage): Parser {
  let parser = parsers.get(language);
  if (parser === undefined) {
    parser = new Parser();
    const module = new WasmModule(readFileSync(grammarUrl(language)));
    parser.setLanguage(Language.loadSync(module as Parameters<typeof Language.loadSync>[0]));
    parsers.set(language, parser);
  }
  return parser;
}

/** Go wraps block statements in a `statement_list` node; its children are the statements. */
function statementsOf(body: Node): readonly (Node | null)[] {
  const children = body.namedChildren;
  const only = children.length === 1 ? children[0] : null;
  return only !== null && only !== undefined && only.type === 'statement_list' ? only.namedChildren : children;
}

function collect(nodes: readonly (Node | null)[], depth: number, rules: LanguageRules, out: Boundary[]): void {
  let commentRun: Node | null = null;
  let lastEnd = -2;
  let lastItemEnd = -2;
  for (const node of nodes) {
    if (node === null) continue;
    const startRow = node.startPosition.row;
    if (rules.comments.has(node.type)) {
      // A comment on the line where the previous item ends trails that item.
      if (startRow !== lastItemEnd && (commentRun === null || startRow > lastEnd + 1)) commentRun = node;
      lastEnd = node.endPosition.row;
      continue;
    }
    const attached = commentRun !== null && startRow <= lastEnd + 1 ? commentRun : null;
    out.push({ line: (attached ?? node).startPosition.row + 1, depth, label: rules.label(node) });
    commentRun = null;
    lastEnd = lastItemEnd = node.endPosition.row;
    const field = rules.bodies[node.type];
    if (field !== undefined && depth < MAX_DEPTH) {
      const body = node.childForFieldName(field);
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
