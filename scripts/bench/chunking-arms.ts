import {
  DEFAULT_CHUNKER, LINE_WINDOW_CHUNKER_VERSION, SYNTAX_CHUNKER_VERSIONS, chunkSnapshot, chunkWithBoundaries, chunkerIdentityFor,
  fallbackWindows, syntaxLanguageOf, type ChunkResult, type SnapshotChunker,
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
 * - `recursive-local`: recursive boundaries, label only where a symbol starts (boundary variable alone).
 * - `recursive`: recursive boundaries with enclosing-symbol labels (the production chunker).
 */
export const CHUNKING_ARMS = ['line-windows', 'typescript-v2', 'recursive-local', 'recursive'] as const;
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

function forJavaScript(arm: string, chunk: (snapshot: SourceSnapshot, limits: WindowLimits) => ChunkResult): SnapshotChunker {
  const isJs = (path: string): boolean => syntaxLanguageOf(path) === 'javascript';
  return {
    identity: (path) => isJs(path) ? `${chunkerIdentityFor(path)}|e1:${arm}` : chunkerIdentityFor(path),
    chunk: (snapshot, limits) => isJs(snapshot.relativePath) ? chunk(snapshot, limits) : DEFAULT_CHUNKER.chunk(snapshot, limits),
  };
}

export function chunkingArm(arm: string): SnapshotChunker {
  switch (arm) {
    case 'recursive': return DEFAULT_CHUNKER;
    case 'recursive-local': return forJavaScript(arm, (snapshot, limits) => chunkSnapshot(snapshot, limits, { javascriptContext: 'local' }));
    case 'typescript-v2': return forJavaScript(arm, previousTypeScript);
    case 'line-windows': return forJavaScript(arm, fallbackWindows);
    default: throw new Error(`--chunker must be one of ${CHUNKING_ARMS.join(', ')}`);
  }
}

/** The chunker version each arm stamps on JS/TS fragments. */
export const armChunkerVersion: Readonly<Record<ChunkingArm, string>> = {
  'line-windows': LINE_WINDOW_CHUNKER_VERSION,
  'typescript-v2': PREVIOUS_TYPESCRIPT_CHUNKER,
  'recursive-local': SYNTAX_CHUNKER_VERSIONS.javascript,
  recursive: SYNTAX_CHUNKER_VERSIONS.javascript,
};
