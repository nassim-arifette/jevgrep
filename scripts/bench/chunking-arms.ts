import {
  DEFAULT_CHUNKER, LINE_WINDOW_CHUNKER_VERSION, SYNTAX_CHUNKER_VERSIONS, chunkSnapshot, chunkWithBoundaries, chunkerIdentityFor,
  fallbackWindows, syntaxLanguageOf, type ChunkResult, type SnapshotChunker, type SyntaxLanguage,
} from '../../src/source/chunker.ts';
import { parseJavaScriptBoundaries } from '../../src/source/javascript-boundaries.ts';
import type { WindowLimits } from '../../src/source/line-windows.ts';
import type { SourceSnapshot } from '../../src/source/snapshot.ts';

/**
 * E1 chunking arms. Only JS/TS files differ between arms; every other file uses the
 * production chunker, so a comparison isolates JS/TS boundaries and metadata.
 *
 * - `line-windows`: JG-012 line windows only.
 * - `typescript-v2`: the previous depth-indexed boundary packing (`jevgrep-typescript-6.0.2-2`).
 * - `recursive`: recursive boundaries, label only where a symbol starts (the production chunker).
 * - `recursive-compact`: recursive boundaries, enclosing symbol names without signatures or spans.
 * - `recursive-enclosing`: recursive boundaries, enclosing symbols with signatures and spans.
 *
 * `go-rust-line-windows` is the Go/Rust counterpart of `line-windows`: Go and Rust files use
 * JG-012 windows instead of Tree-sitter boundaries, everything else is production.
 */
export const CHUNKING_ARMS = ['line-windows', 'typescript-v2', 'recursive', 'recursive-compact', 'recursive-enclosing', 'go-rust-line-windows'] as const;
export type ChunkingArm = typeof CHUNKING_ARMS[number];

const PREVIOUS_TYPESCRIPT_CHUNKER = 'jevgrep-typescript-6.0.2-2';

function previousTypeScript(snapshot: SourceSnapshot, limits: WindowLimits): ChunkResult {
  const scan = parseJavaScriptBoundaries(snapshot.text, (offset) => snapshot.lineOfUtf16(offset), snapshot.relativePath);
  if (!scan.ok) {
    const windows = fallbackWindows(snapshot, limits);
    return windows.kind === 'fragments' ? { ...windows, fallback: 'parse_failure' } : windows;
  }
  return chunkWithBoundaries(snapshot, scan.boundaries, limits, PREVIOUS_TYPESCRIPT_CHUNKER);
}

function forLanguages(
  arm: string, languages: readonly SyntaxLanguage[], chunk: (snapshot: SourceSnapshot, limits: WindowLimits) => ChunkResult,
): SnapshotChunker {
  const covered = (path: string): boolean => languages.includes(syntaxLanguageOf(path)!);
  return {
    identity: (path) => covered(path) ? `${chunkerIdentityFor(path)}|e1:${arm}` : chunkerIdentityFor(path),
    chunk: (snapshot, limits) => covered(snapshot.relativePath) ? chunk(snapshot, limits) : DEFAULT_CHUNKER.chunk(snapshot, limits),
  };
}

const forJavaScript = (arm: string, chunk: (snapshot: SourceSnapshot, limits: WindowLimits) => ChunkResult): SnapshotChunker =>
  forLanguages(arm, ['javascript'], chunk);

export function chunkingArm(arm: string): SnapshotChunker {
  switch (arm) {
    case 'recursive': return DEFAULT_CHUNKER;
    case 'recursive-enclosing': return forJavaScript(arm, (snapshot, limits) => chunkSnapshot(snapshot, limits, { javascriptContext: 'enclosing' }));
    case 'recursive-compact': return forJavaScript(arm, (snapshot, limits) => chunkSnapshot(snapshot, limits, { javascriptContext: 'compact' }));
    case 'typescript-v2': return forJavaScript(arm, previousTypeScript);
    case 'line-windows': return forJavaScript(arm, fallbackWindows);
    case 'go-rust-line-windows': return forLanguages(arm, ['go', 'rust'], fallbackWindows);
    default: throw new Error(`--chunker must be one of ${CHUNKING_ARMS.join(', ')}`);
  }
}

/** The chunker version each arm stamps on the fragments of the languages it changes. */
export const armChunkerVersion: Readonly<Record<ChunkingArm, string>> = {
  'line-windows': LINE_WINDOW_CHUNKER_VERSION,
  'typescript-v2': PREVIOUS_TYPESCRIPT_CHUNKER,
  recursive: SYNTAX_CHUNKER_VERSIONS.javascript,
  'recursive-compact': SYNTAX_CHUNKER_VERSIONS.javascript,
  'recursive-enclosing': SYNTAX_CHUNKER_VERSIONS.javascript,
  'go-rust-line-windows': LINE_WINDOW_CHUNKER_VERSION,
};
