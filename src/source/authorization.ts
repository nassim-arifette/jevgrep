/**
 * Containment of every read inside the authorized repository root.
 *
 * JG-008 owns the hardened version of this control and its Windows/POSIX attack
 * fixtures; this module implements the containment contract that the inventory
 * (JG-010) and the snapshot reader (JG-011) consume, so that no stage has to invent
 * its own path rules. Keep the interface narrow: callers ask for a resolved entry or
 * for bytes, never for "is this string fine".
 *
 * Specification section 5.1: the configured root is canonicalized once, every
 * requested path and every discovered entry is validated against it before being
 * opened, links and reparse points are refused rather than followed, and a path
 * comparison is done on segments under platform semantics, never on raw prefixes.
 * This is not an OS sandbox; concurrent replacement of a file between validation and
 * read remains possible and is documented rather than hidden.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';

/** Why a path may not be used. These map onto contract exclusion reasons. */
export type PathRefusal =
  | 'outside_root'
  | 'link'
  | 'not_regular_file'
  | 'unsupported_path_syntax'
  | 'missing';

export class UnauthorizedPathError extends Error {
  override readonly name = 'UnauthorizedPathError';
  readonly refusal: PathRefusal;
  /** Repository-relative path when it is known; the raw request otherwise. */
  readonly requestedPath: string;

  constructor(refusal: PathRefusal, requestedPath: string, detail: string) {
    super(`${refusal}: ${detail}`);
    this.refusal = refusal;
    this.requestedPath = requestedPath;
  }
}

export type EntryKind = 'file' | 'directory';

export type ResolvedEntry = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: EntryKind;
  readonly sizeBytes: number;
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;

/**
 * Lexical validation of a repository-relative path, before touching the filesystem.
 * Rejects traversal, absolute and drive-relative forms, UNC and device namespaces,
 * NUL, alternate data streams and Windows reserved device names.
 */
export function assertSafeRelativePath(input: string): string {
  const fail = (detail: string): never => {
    throw new UnauthorizedPathError('unsupported_path_syntax', input, detail);
  };
  if (input.length === 0) {
    return fail('empty path');
  }
  if (input.includes('\u0000')) {
    return fail('NUL byte in path');
  }
  const unified = input.replaceAll('\\', '/');
  if (unified.startsWith('/')) {
    return fail('absolute, UNC and device paths are forbidden');
  }
  if (/^[A-Za-z]:/.test(unified)) {
    return fail('drive-relative and drive-absolute paths are forbidden');
  }
  if (unified.includes(':')) {
    return fail('alternate data stream syntax is forbidden');
  }
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    return fail('parent traversal is forbidden');
  }
  for (const segment of segments) {
    if (/[\u0000-\u001f\u007f<>"|?*]/.test(segment)) {
      return fail('unsupported character in path');
    }
    if (/[. ]$/.test(segment)) {
      return fail('trailing dot or space is ambiguous on Windows');
    }
    if (WINDOWS_RESERVED.test(segment)) {
      return fail('Windows reserved device name');
    }
  }
  return segments.join('/') || '.';
}

function foldCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Split an absolute path into comparable segments. */
function segmentsOf(absolutePath: string): string[] {
  return absolutePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * The authorized repository root, and the only door to its contents.
 *
 * Instances are created once per search from the trusted configuration; they never
 * accept a new root from a request, an MCP client or repository text.
 */
export class AuthorizedRoot {
  /** Canonical absolute path of the root. */
  readonly path: string;
  readonly #rootSegments: readonly string[];

  private constructor(canonicalRoot: string) {
    this.path = canonicalRoot;
    this.#rootSegments = segmentsOf(canonicalRoot).map(foldCase);
  }

  /** Canonicalize the configured root once. A link as the root itself is refused. */
  static open(rootPath: string): AuthorizedRoot {
    const absolute = resolve(rootPath);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      throw new UnauthorizedPathError('missing', absolute, `the authorized root does not exist: ${absolute}`);
    }
    if (stats.isSymbolicLink()) {
      throw new UnauthorizedPathError('link', absolute, `the authorized root is a link: ${absolute}`);
    }
    if (!stats.isDirectory()) {
      throw new UnauthorizedPathError('not_regular_file', absolute, `the authorized root is not a directory: ${absolute}`);
    }
    return new AuthorizedRoot(realpathSync.native(absolute));
  }

  /**
   * Segment-wise containment. A sibling directory whose name merely starts with the
   * root's name (`repo-other` next to `repo`) is not contained.
   */
  contains(absolutePath: string): boolean {
    const candidate = segmentsOf(resolve(absolutePath)).map(foldCase);
    if (candidate.length < this.#rootSegments.length) {
      return false;
    }
    return this.#rootSegments.every((segment, index) => candidate[index] === segment);
  }

  /** Repository-relative path with '/' separators. Throws when the path is not contained. */
  relativize(absolutePath: string): string {
    const absolute = resolve(absolutePath);
    if (!this.contains(absolute)) {
      throw new UnauthorizedPathError('outside_root', absolute, `${absolute} is outside ${this.path}`);
    }
    const relative = segmentsOf(absolute).slice(this.#rootSegments.length);
    return relative.join('/') || '.';
  }

  /**
   * Identity used to deduplicate overlapping scope entries. On Windows the folded
   * path is the identity the platform itself uses; elsewhere the exact path is.
   */
  identityKey(absolutePath: string): string {
    return foldCase(resolve(absolutePath));
  }

  /**
   * Resolve a repository-relative path and validate every segment on the way down.
   * Any link, junction or reparse point in the chain refuses the whole path.
   */
  resolveEntry(relativePath: string): ResolvedEntry {
    const normalized = assertSafeRelativePath(relativePath);
    if (normalized === '.') {
      const stats = lstatSync(this.path);
      return { relativePath: '.', absolutePath: this.path, kind: 'directory', sizeBytes: stats.size };
    }

    let current = this.path;
    const segments = normalized.split('/');
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const last = index === segments.length - 1;
      let stats;
      try {
        stats = lstatSync(current);
      } catch {
        throw new UnauthorizedPathError('missing', normalized, `${normalized} does not exist inside the authorized root`);
      }
      if (stats.isSymbolicLink()) {
        throw new UnauthorizedPathError('link', normalized, `${normalized} traverses a link, which v1 never follows`);
      }
      if (!last && !stats.isDirectory()) {
        throw new UnauthorizedPathError('not_regular_file', normalized, `${normalized} traverses a non-directory`);
      }
      if (last) {
        if (stats.isDirectory()) {
          return { relativePath: normalized, absolutePath: current, kind: 'directory', sizeBytes: stats.size };
        }
        if (!stats.isFile()) {
          throw new UnauthorizedPathError('not_regular_file', normalized, `${normalized} is not a regular file`);
        }
        if (!this.contains(current)) {
          throw new UnauthorizedPathError('outside_root', normalized, `${normalized} resolves outside the authorized root`);
        }
        return { relativePath: normalized, absolutePath: current, kind: 'file', sizeBytes: stats.size };
      }
    }
    /* c8 ignore next */
    throw new UnauthorizedPathError('unsupported_path_syntax', relativePath, 'unreachable path resolution');
  }

  /**
   * Read a validated file's original bytes.
   *
   * Containment and file type are checked again against the open descriptor, so a
   * directory entry swapped for a link between listing and reading is refused instead
   * of read. A concurrent replacement of the file contents themselves is still
   * possible; the snapshot hash is what identifies the bytes that were used.
   */
  readFileBytes(absolutePath: string, maxBytes: number): Buffer {
    const absolute = resolve(absolutePath);
    if (!this.contains(absolute)) {
      throw new UnauthorizedPathError('outside_root', absolute, `${absolute} is outside ${this.path}`);
    }
    const linkCheck = lstatSync(absolute);
    if (linkCheck.isSymbolicLink()) {
      throw new UnauthorizedPathError('link', absolute, `${absolute} became a link before reading`);
    }
    const parent = dirname(absolute);
    if (parent !== absolute && realpathSync.native(parent) !== parent) {
      throw new UnauthorizedPathError('link', absolute, `${absolute} sits under a reparse point`);
    }

    const descriptor = openSync(absolute, 'r');
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) {
        throw new UnauthorizedPathError('not_regular_file', absolute, `${basename(absolute)} is not a regular file`);
      }
      if (stats.size > maxBytes) {
        throw new UnauthorizedPathError('not_regular_file', absolute,
          `${basename(absolute)} grew past the configured ${String(maxBytes)} byte limit before reading`);
      }
      const buffer = Buffer.allocUnsafe(Number(stats.size));
      let read = 0;
      while (read < buffer.length) {
        const chunk = readSync(descriptor, buffer, read, buffer.length - read, read);
        if (chunk === 0) {
          break;
        }
        read += chunk;
      }
      return read === buffer.length ? buffer : buffer.subarray(0, read);
    } finally {
      closeSync(descriptor);
    }
  }

  /** Absolute path of a child entry of an already-validated directory. */
  child(absoluteDirectory: string, name: string): string {
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new UnauthorizedPathError('unsupported_path_syntax', name, `unsupported directory entry name: ${name}`);
    }
    return join(absoluteDirectory, name) + (absoluteDirectory.endsWith(sep) ? '' : '');
  }
}
