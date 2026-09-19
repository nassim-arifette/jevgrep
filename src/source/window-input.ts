/**
 * Adapter between a prepared source snapshot (JG-011) and the window chunker (JG-012).
 *
 * The chunker takes a narrow structural view - a relative path, the decoded text and the
 * file hash - instead of the snapshot class, so the two modules stay replaceable and can be
 * reviewed separately. This is the one place that knows the snapshot happens to name its path
 * `relativePath`.
 *
 * Deliberately structural: nothing here imports the snapshot module, so the adapter compiles
 * and is tested while that module is still in review. M's `SourceSnapshot` satisfies
 * `SnapshotLike` as written (own properties `relativePath`, `text`, `sha256`).
 */
import type { SnapshotText } from './line-windows.ts';

/** The part of a prepared snapshot the chunker consumes. */
export type SnapshotLike = {
  /** Normalized relative path inside the authorized root. */
  readonly relativePath: string;
  /** Decoded original text: newlines, whitespace, Unicode and BOM preserved. */
  readonly text: string;
  /** SHA-256 of the original bytes. */
  readonly sha256: string;
};

function refuse(detail: string): never {
  throw new TypeError(`snapshot cannot be chunked: ${detail}`);
}

/**
 * Map one prepared snapshot onto the chunker input.
 *
 * The text and the hash are passed through untouched: the chunker's excerpts must remain
 * exact slices of the captured bytes, and its metadata must name the same file revision the
 * snapshot hashed. A snapshot that could not become evidence (no path, no hash, no text) is
 * refused loudly rather than producing fragments with missing provenance.
 */
export function windowInputOf(snapshot: SnapshotLike): SnapshotText {
  const { relativePath, text, sha256 } = snapshot;
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    refuse('the snapshot has no relativePath');
  }
  if (typeof text !== 'string') {
    refuse('the snapshot has no decoded text');
  }
  if (typeof sha256 !== 'string' || sha256.trim().length === 0) {
    refuse('the snapshot has no sha256');
  }
  const path = relativePath.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    refuse(`'${relativePath}' is absolute; snapshots belong to the authorized root`);
  }
  return { path, text, sha256 };
}

/** Map several snapshots in order, preserving the inventory order they were given in. */
export function windowInputsOf(snapshots: readonly SnapshotLike[]): readonly SnapshotText[] {
  return snapshots.map((snapshot) => windowInputOf(snapshot));
}
