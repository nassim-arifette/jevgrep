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
 * attached to it; Rust attributes (`#[...]`, `#![...]`) always attach to the next item,
 * together with the comments directly above them. Go function literals held by a `var`,
 * `go` or `defer` statement are refined like function bodies.
 *
 * Labels: Go methods carry their receiver type (`method:Server.ServeHTTP`), Go `const`
 * and `var` declarations their first name. Rust trait impls are `impl:Display for Config`;
 * impl trait and type names drop their path qualifier and keep generic arguments as
 * written (`impl fmt::Display for crate::Config<T>` is `impl:Display for Config<T>`).
 * `macro_rules!` definitions and item-level macro calls are `macro:name`.
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
  /** Node types that always attach to the next item, with the comments directly above them. */
  readonly attributes: ReadonlySet<string>;
  /** The body whose named children are the next depth, for nodes that have one. */
  readonly bodyOf: (node: Node) => Node | null;
  readonly label: (node: Node) => string | null;
};

const nameOf = (node: Node): string | null => node.childForFieldName('name')?.text ?? null;
const labelled = (kind: string, name: string | null): string | null => (name === null ? null : `${kind}:${name}`);
const bodyField = (node: Node): Node | null => node.childForFieldName('body');

/** `T`, `*T`, `T[K]`, `*T[K]` or `(T)` receiver of a Go method → `T`. */
function goReceiverType(method: Node): string | null {
  const parameter = method.childForFieldName('receiver')?.namedChildren.find((child) => child?.type === 'parameter_declaration');
  let type = parameter?.childForFieldName('type') ?? null;
  while (type !== null && type.type !== 'type_identifier') {
    type = type.type === 'generic_type' ? type.childForFieldName('type') : type.type === 'pointer_type' || type.type === 'parenthesized_type' ? type.namedChildren[0] ?? null : null;
  }
  return type?.text ?? null;
}

/** First spec of a `const`/`var` declaration, inside a grouped `( ... )` list or not. */
function goFirstSpec(declaration: Node, spec: string): Node | null {
  for (const child of declaration.namedChildren) {
    if (child?.type === spec) return child;
    if (child?.type === `${spec}_list`) return child.namedChildren.find((inner) => inner?.type === spec) ?? null;
  }
  return null;
}

/** The function literal of `var h = func…`, `go func(){…}()` or `defer func(){…}()`. */
function goFuncLiteral(node: Node): Node | null {
  if (node.type === 'var_declaration') {
    const specs = node.namedChildren.filter((child) => child?.type === 'var_spec');
    const values = specs.length === 1 ? specs[0]!.childForFieldName('value')?.namedChildren ?? [] : [];
    return values.length === 1 && values[0]?.type === 'func_literal' ? values[0] : null;
  }
  const call = node.namedChildren[0];
  const callee = call?.type === 'call_expression' ? call.childForFieldName('function') : null;
  return callee?.type === 'func_literal' ? callee : null;
}

/** A Rust type or path as written, without its path qualifier: `fmt::Display` → `Display`. */
function rustUnqualified(node: Node | null): string | null {
  if (node === null) return null;
  switch (node.type) {
    case 'scoped_type_identifier': case 'scoped_identifier': return rustUnqualified(node.childForFieldName('name'));
    case 'generic_type': {
      const base = rustUnqualified(node.childForFieldName('type'));
      const typeArguments = node.childForFieldName('type_arguments')?.text ?? '';
      return base === null ? null : `${base}${typeArguments}`;
    }
    default: return node.text;
  }
}

function rustImplLabel(node: Node): string | null {
  const type = rustUnqualified(node.childForFieldName('type'));
  const trait = rustUnqualified(node.childForFieldName('trait'));
  return labelled('impl', type === null || trait === null ? type : `${trait} for ${type}`);
}

/** Only macro calls standing as items (`lazy_static! { ... }`) are labelled, not calls in expressions. */
const RUST_ITEM_CONTAINERS = new Set(['source_file', 'declaration_list']);

const RULES: Readonly<Record<TreeSitterLanguage, LanguageRules>> = {
  go: {
    comments: new Set(['comment']),
    attributes: new Set(),
    bodyOf: (node) => {
      switch (node.type) {
        case 'function_declaration': case 'method_declaration': return bodyField(node);
        case 'var_declaration': case 'go_statement': case 'defer_statement': {
          const literal = goFuncLiteral(node);
          return literal === null ? null : bodyField(literal);
        }
        default: return null;
      }
    },
    label: (node) => {
      switch (node.type) {
        case 'function_declaration': return labelled('function', nameOf(node));
        case 'method_declaration': {
          const name = nameOf(node);
          const receiver = goReceiverType(node);
          return labelled('method', receiver === null || name === null ? name : `${receiver}.${name}`);
        }
        case 'const_declaration': return labelled('const', nameOf(goFirstSpec(node, 'const_spec') ?? node));
        case 'var_declaration': return labelled('var', nameOf(goFirstSpec(node, 'var_spec') ?? node));
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
    attributes: new Set(['attribute_item', 'inner_attribute_item']),
    bodyOf: (node) => (['function_item', 'impl_item', 'trait_item', 'mod_item'].includes(node.type) ? bodyField(node) : null),
    label: (node) => {
      switch (node.type) {
        case 'function_item': return labelled('function', nameOf(node));
        case 'struct_item': return labelled('struct', nameOf(node));
        case 'enum_item': return labelled('enum', nameOf(node));
        case 'trait_item': return labelled('trait', nameOf(node));
        case 'mod_item': return labelled('mod', nameOf(node));
        case 'type_item': return labelled('type', nameOf(node));
        case 'impl_item': return rustImplLabel(node);
        case 'const_item': return labelled('const', nameOf(node));
        case 'static_item': return labelled('static', nameOf(node));
        case 'union_item': return labelled('union', nameOf(node));
        case 'macro_definition': return labelled('macro', nameOf(node));
        case 'macro_invocation':
          return RUST_ITEM_CONTAINERS.has(node.parent?.type ?? '') ? labelled('macro', rustUnqualified(node.childForFieldName('macro'))) : null;
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
