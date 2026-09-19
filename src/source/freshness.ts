/**
 * Freshness of selected sources before rendering (JG-021).
 *
 * A score was computed on a snapshot. If the file changed or disappeared while the
 * search was running, returning its current lines with that score would attach a
 * judgment to content the provider never saw (specification sections 4.3 and 8.1).
 *
 * The rules this module enforces:
 * - one revalidation attempt per candidate file, so a working tree that keeps
 *   changing cannot loop the search;
 * - a file found stale is unavailable for the rest of the search and never returns;
 * - freed response space may be filled from candidates already evaluated, and every
 *   newly introduced file passes its own check before it is included;
 * - no paid re-evaluation is triggered to repair a stale source.
 */
import { AuthorizedRoot, UnauthorizedPathError } from './authorization.ts';
import { hashBytes } from './snapshot.ts';

export type FreshnessVerdict = 'fresh' | 'stale' | 'unreadable';

export type FreshnessCheck = {
  readonly path: string;
  readonly verdict: FreshnessVerdict;
  /** True the first time this file was checked; repeated calls reuse the verdict. */
  readonly firstCheck: boolean;
};

export type FreshnessReader = (relativePath: string) => Buffer;

/**
 * Tracks revalidation verdicts for one search.
 *
 * The tracker is the only place allowed to decide that a file became unavailable, so
 * the rest of the engine has a single, consistent view of staleness.
 */
export class FreshnessTracker {
  readonly #read: FreshnessReader;
  readonly #verdicts = new Map<string, FreshnessVerdict>();
  readonly #stale = new Set<string>();
  #checks = 0;

  constructor(read: FreshnessReader) {
    this.#read = read;
  }

  /** Files proven stale or unreadable; selection must not use them again. */
  get unavailablePaths(): ReadonlySet<string> {
    return this.#stale;
  }

  /** Number of revalidation attempts actually performed; bounded by one per file. */
  get checkCount(): number {
    return this.#checks;
  }

  /** Verify that a path still hashes to the snapshot that was evaluated. */
  check(relativePath: string, expectedSha256: string): FreshnessCheck {
    const known = this.#verdicts.get(relativePath);
    if (known !== undefined) {
      return { path: relativePath, verdict: known, firstCheck: false };
    }

    this.#checks += 1;
    let verdict: FreshnessVerdict;
    try {
      verdict = hashBytes(this.#read(relativePath)) === expectedSha256 ? 'fresh' : 'stale';
    } catch (cause) {
      verdict = cause instanceof UnauthorizedPathError ? 'stale' : 'unreadable';
    }
    this.#verdicts.set(relativePath, verdict);
    if (verdict !== 'fresh') {
      this.#stale.add(relativePath);
    }
    return { path: relativePath, verdict, firstCheck: true };
  }
}

/** Read bytes through the authorized root, so revalidation obeys the same containment. */
export function rootReader(root: AuthorizedRoot, maxFileBytes: number): FreshnessReader {
  return (relativePath: string): Buffer => {
    const entry = root.resolveEntry(relativePath);
    if (entry.kind !== 'file') {
      throw new UnauthorizedPathError('not_regular_file', relativePath, `${relativePath} is no longer a regular file`);
    }
    return root.readFileBytes(entry.absolutePath, maxFileBytes);
  };
}
