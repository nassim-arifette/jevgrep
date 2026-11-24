/**
 * Pinned Tree-sitter grammars (WASM) for Go and Rust.
 *
 * Tree-sitter only parses the supplied text: nothing is imported, compiled or run, and
 * no native addon is loaded. The grammars are vendored `.wasm` files (MIT, see the
 * LICENSE files next to them) so installing JevGrep runs no install script.
 */
import { readFileSync } from 'node:fs';
import { Language, Parser } from 'web-tree-sitter';

export type TreeSitterLanguage = 'go' | 'rust';

/** Grammar package versions of the vendored WASM files; part of the chunker version. */
export const TREE_SITTER_GRAMMARS: Readonly<Record<TreeSitterLanguage, string>> = {
  go: 'tree-sitter-go-0.25.0',
  rust: 'tree-sitter-rust-0.24.0',
};

await Parser.init();
const grammarUrl = (language: TreeSitterLanguage): URL => new URL(`./grammars/tree-sitter-${language}.wasm`, import.meta.url);
const parsers = new Map<TreeSitterLanguage, Parser>();
// Node's global WebAssembly is not in this project's type libraries.
const WasmModule = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => unknown } }).WebAssembly.Module;

/** Grammars compile on first use, so a scope without Go or Rust never loads one. */
export function parserFor(language: TreeSitterLanguage): Parser {
  let parser = parsers.get(language);
  if (parser === undefined) {
    parser = new Parser();
    const module = new WasmModule(readFileSync(grammarUrl(language)));
    parser.setLanguage(Language.loadSync(module as Parameters<typeof Language.loadSync>[0]));
    parsers.set(language, parser);
  }
  return parser;
}
