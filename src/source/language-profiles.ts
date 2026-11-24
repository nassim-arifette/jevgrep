/**
 * Declarative language profiles (language search spec 3.1, LS-2).
 *
 * A profile says how a language is detected, which parser reads it and how the shared
 * planner (`syntax-planner.ts`) sees its tree: which nodes are leading trivia, which
 * symbols a node introduces and which of them are declarations. Recursion itself is
 * not configured: an oversized node is split along its named children, so every
 * statement list, match arm, member list or literal is a split point, at any depth.
 *
 * JS/TS, Go and Rust are planned by the shared planner. Python and Java keep their
 * hand-written scanners and the depth-indexed boundary packing until phase 2.
 */
import type { Node } from 'web-tree-sitter';

import { TREE_SITTER_GRAMMARS } from './tree-sitter-parser.ts';
import type { TreeSitterLanguage } from './tree-sitter-parser.ts';

export type SyntaxLanguage = 'javascript' | 'python' | 'java' | 'go' | 'rust';

/** The symbol a node introduces: `{ kind: 'impl', name: 'Display for Config' }` renders `impl:Display for Config`. */
export type ProfileSymbol = { readonly kind: string; readonly name: string };

type BaseProfile = {
  readonly id: SyntaxLanguage;
  /** Chunker version, bumped when the language's fragments change; part of evaluation identity (JG-018). */
  readonly version: string;
  readonly detect: { readonly extensions: readonly string[] };
};

export type TypeScriptProfile = BaseProfile & {
  readonly parser: { readonly kind: 'typescript' };
  /** Symbol kinds that are declarations: a fragment cut from one records its range. */
  readonly declarations: ReadonlySet<string>;
};

export type TreeSitterProfile = BaseProfile & {
  readonly parser: { readonly kind: 'tree-sitter'; readonly grammar: TreeSitterLanguage };
  readonly leading: {
    /** Comments directly above a node attach to it, unless they trail the previous node's last line. */
    readonly comments: ReadonlySet<string>;
    /** Attributes always attach to the next node, across blank lines, with the comments directly above them. */
    readonly attributes: ReadonlySet<string>;
  };
  /** Symbol kinds that are declarations: a fragment cut from one records its range. */
  readonly declarations: ReadonlySet<string>;
  readonly label: (node: Node) => ProfileSymbol | null;
};

export type ScannerProfile = BaseProfile & { readonly parser: { readonly kind: 'scanner'; readonly name: string } };

export type LanguageProfile = TypeScriptProfile | TreeSitterProfile | ScannerProfile;

const nameOf = (node: Node): string | null => node.childForFieldName('name')?.text ?? null;
const labelled = (kind: string, name: string | null): ProfileSymbol | null => (name === null ? null : { kind, name });

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

function rustImplLabel(node: Node): ProfileSymbol | null {
  const type = rustUnqualified(node.childForFieldName('type'));
  const trait = rustUnqualified(node.childForFieldName('trait'));
  return labelled('impl', type === null || trait === null ? type : `${trait} for ${type}`);
}

/** Only macro calls standing as items (`lazy_static! { ... }`) are labelled, not calls in expressions. */
const RUST_ITEM_CONTAINERS = new Set(['source_file', 'declaration_list']);

/**
 * Go labels: methods carry their receiver type (`method:Server.ServeHTTP`), `const` and
 * `var` declarations their first name, `type` declarations their first spec.
 */
function goLabel(node: Node): ProfileSymbol | null {
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
}

/**
 * Rust labels: trait impls are `impl:Display for Config`; impl trait and type names drop
 * their path qualifier and keep generic arguments as written. `macro_rules!` definitions
 * and item-level macro calls are `macro:name`.
 */
function rustLabel(node: Node): ProfileSymbol | null {
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
}

export const JAVASCRIPT_PROFILE: TypeScriptProfile = {
  id: 'javascript',
  version: 'jevgrep-typescript-6.0.2-4',
  detect: { extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'] },
  parser: { kind: 'typescript' },
  declarations: new Set([
    'function', 'component', 'method', 'getter', 'setter', 'class', 'interface', 'type', 'enum', 'namespace', 'object',
    'variable', 'callback',
  ]),
};

export const GO_PROFILE: TreeSitterProfile = {
  id: 'go',
  version: `jevgrep-${TREE_SITTER_GRAMMARS.go}-4`,
  detect: { extensions: ['.go'] },
  parser: { kind: 'tree-sitter', grammar: 'go' },
  leading: { comments: new Set(['comment']), attributes: new Set() },
  declarations: new Set(['function', 'method', 'const', 'var', 'type']),
  label: goLabel,
};

export const RUST_PROFILE: TreeSitterProfile = {
  id: 'rust',
  version: `jevgrep-${TREE_SITTER_GRAMMARS.rust}-4`,
  detect: { extensions: ['.rs'] },
  parser: { kind: 'tree-sitter', grammar: 'rust' },
  leading: { comments: new Set(['line_comment', 'block_comment']), attributes: new Set(['attribute_item', 'inner_attribute_item']) },
  declarations: new Set(['function', 'struct', 'enum', 'trait', 'mod', 'type', 'impl', 'const', 'static', 'union', 'macro']),
  label: rustLabel,
};

export const LANGUAGE_PROFILES: Readonly<Record<SyntaxLanguage, LanguageProfile>> = {
  javascript: JAVASCRIPT_PROFILE,
  python: { id: 'python', version: 'jevgrep-python-scan-2', detect: { extensions: ['.py', '.pyi'] }, parser: { kind: 'scanner', name: 'python' } },
  java: { id: 'java', version: 'jevgrep-java-scan-3', detect: { extensions: ['.java'] }, parser: { kind: 'scanner', name: 'java' } },
  go: GO_PROFILE,
  rust: RUST_PROFILE,
};
