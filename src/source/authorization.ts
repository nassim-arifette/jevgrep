/**
 * Rooted source access (JG-008). All inventory, ignore-file and content reads cross
 * this interface. A root identity is pinned for the loaded configuration's lifetime.
 * Checks narrow observable replacement races; they are not an atomic OS sandbox.
 */
import fs from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { assertNoReparsePoints, AttributeCheckError } from './windows-attributes.ts';

export type PathRefusal = 'outside_root' | 'link' | 'not_regular_file'
  | 'unsupported_path_syntax' | 'missing' | 'changed' | 'too_large' | 'unavailable';

export class UnauthorizedPathError extends Error {
  override readonly name = 'UnauthorizedPathError';
  readonly refusal: PathRefusal;
  readonly requestedPath: string;

  constructor(refusal: PathRefusal, requestedPath: string, detail: string) {
    super(`${refusal}: ${detail}`);
    this.refusal = refusal;
    this.requestedPath = requestedPath;
  }
}

export type ResolvedEntry = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: 'file' | 'directory';
  readonly sizeBytes: number;
};

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;

/** Validate before touching the filesystem, using the shared portable path policy. */
export function assertSafeRelativePath(input: string): string {
  const fail = (): never => {
    throw new UnauthorizedPathError('unsupported_path_syntax', input, 'unsupported relative path syntax');
  };
  if (input.length === 0 || /[\u0000-\u001f\u007f<>:"|?*]/.test(input)) return fail();
  const unified = input.replaceAll('\\', '/');
  if (unified.startsWith('/')) return fail();
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..' || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment))) return fail();
  return segments.join('/') || '.';
}

type CheckedEntry = { readonly path: string; readonly stats: BigIntStats };
type Walk = { readonly entry: ResolvedEntry; readonly chain: readonly CheckedEntry[] };

function fail(reason: PathRefusal, path: string): never {
  throw new UnauthorizedPathError(reason, path, `source access refused (${reason})`);
}

/** No case folding: Windows also permits case-sensitive directories. */
function contained(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Drive-root-first paths; checking them in order never skips an ancestor. */
function ancestors(absolute: string): string[] {
  if (!isAbsolute(absolute) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(absolute))) {
    return fail('unsupported_path_syntax', absolute);
  }
  const prefix = parse(absolute).root;
  const paths = [prefix];
  let current = prefix;
  for (const part of absolute.slice(prefix.length).split(sep).filter(Boolean)) {
    if (assertSafeRelativePath(part) !== part) return fail('unsupported_path_syntax', absolute);
    current = join(current, part);
    paths.push(current);
  }
  return paths;
}

function checkWindows(paths: readonly string[], requested: string): void {
  try {
    assertNoReparsePoints(paths);
  } catch (cause) {
    if (cause instanceof AttributeCheckError) return fail(cause.kind, cause.path ?? requested);
    throw cause;
  }
}

function metadata(path: string): BigIntStats {
  let stats: BigIntStats;
  try {
    stats = fs.lstatSync(path, { bigint: true });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return fail(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable', path);
  }
  if (stats.isSymbolicLink()) return fail('link', path);
  if (!stats.isDirectory() && !stats.isFile()) return fail('not_regular_file', path);
  return stats;
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile();
}

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return sameObject(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function checkChain(chain: readonly CheckedEntry[]): void {
  const paths = chain.map((entry) => entry.path);
  checkWindows(paths, paths.at(-1) ?? '.');
  for (const expected of chain) {
    if (!sameObject(expected.stats, metadata(expected.path))) fail('changed', expected.path);
  }
}

function checkedAncestors(absolute: string): CheckedEntry[] {
  const paths = ancestors(absolute);
  checkWindows(paths, absolute);
  return paths.map((path) => {
    const stats = metadata(path);
    if (!stats.isDirectory()) return fail('not_regular_file', path);
    return { path, stats };
  });
}

export class AuthorizedRoot {
  readonly path: string;
  readonly #anchor: readonly CheckedEntry[];
  #invalidated = false;

  private constructor(path: string, anchor: readonly CheckedEntry[]) {
    this.path = path;
    this.#anchor = anchor;
  }

  /** Refuse linked ancestors before canonicalization can hide them. */
  static open(rootPath: string): AuthorizedRoot {
    const requested = resolve(rootPath);
    const before = checkedAncestors(requested);
    const canonical = fs.realpathSync.native(requested);
    const anchor = checkedAncestors(canonical);
    if (!sameObject(before.at(-1)!.stats, anchor.at(-1)!.stats)) return fail('changed', requested);
    checkChain(before);
    return new AuthorizedRoot(canonical, anchor);
  }

  /** Lexical check only; actual access always revalidates the retained anchor. */
  contains(absolutePath: string): boolean {
    return contained(resolve(absolutePath), this.path);
  }

  relativize(absolutePath: string): string {
    const absolute = resolve(absolutePath);
    if (!this.contains(absolute)) return fail('outside_root', absolute);
    return absolute.slice(this.path.length).split(sep).filter(Boolean).join('/') || '.';
  }

  /** Filesystem-resolved spelling merges aliases without merging distinct hard links. */
  identityKey(absolutePath: string): string {
    return this.resolveEntry(this.relativize(absolutePath)).absolutePath;
  }

  /** A failed anchor stays invalid even if the original directory is later restored. */
  assertCurrent(): void {
    if (this.#invalidated) return fail('changed', this.path);
    try {
      checkChain(this.#anchor);
    } catch (cause) {
      this.#invalidated = true;
      throw cause;
    }
  }

  #checked<T>(operation: () => T): T {
    try {
      return operation();
    } catch (cause) {
      if (cause instanceof UnauthorizedPathError
        && this.#anchor.some((entry) => entry.path === cause.requestedPath)) {
        this.#invalidated = true;
      } else {
        // A failed descendant lookup may have crossed a root changed since the
        // first check. Preserve any anchor failure before returning to a caller
        // which may legitimately continue a partial scan after a leaf failure.
        try { this.assertCurrent(); } catch { /* assertCurrent retains the failure */ }
      }
      throw cause;
    }
  }

  resolveEntry(relativePath: string): ResolvedEntry {
    return this.#walk(relativePath).entry;
  }

  #walk(relativePath: string): Walk {
    const normalized = assertSafeRelativePath(relativePath);
    return this.#checked(() => this.#resolveWalk(normalized));
  }

  #resolveWalk(normalized: string): Walk {
    this.assertCurrent();
    const chain = [...this.#anchor];
    let current = this.path;
    const parts = normalized === '.' ? [] : normalized.split('/');
    const requestedPaths = [...chain.map((entry) => entry.path)];
    for (const part of parts) {
      current = join(current, part);
      requestedPaths.push(current);
    }
    checkWindows(requestedPaths, normalized);
    current = this.path;
    for (const [index, part] of parts.entries()) {
      const candidate = join(current, part);
      const stats = metadata(candidate);
      if (index < parts.length - 1 && !stats.isDirectory()) return fail('not_regular_file', normalized);
      const canonical = fs.realpathSync.native(candidate);
      if (!contained(canonical, this.path)) return fail('outside_root', normalized);
      if (!sameObject(stats, metadata(canonical))) return fail('changed', normalized);
      current = canonical;
      chain.push({ path: current, stats });
    }
    this.#checked(() => checkChain(chain));
    const last = chain.at(-1)!;
    if (last.stats.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('too_large', normalized);
    return {
      entry: {
        relativePath: this.relativize(current), absolutePath: current,
        kind: last.stats.isDirectory() ? 'directory' : 'file', sizeBytes: Number(last.stats.size),
      },
      chain,
    };
  }

  /** No caller performs unchecked readdir or ignore-file reads. */
  readDirectory(relativePath: string): Dirent[] {
    const checked = this.#walk(relativePath);
    if (checked.entry.kind !== 'directory') return fail('not_regular_file', relativePath);
    const entries = fs.readdirSync(checked.entry.absolutePath, { withFileTypes: true });
    this.#checked(() => checkChain(checked.chain));
    return entries;
  }

  /**
   * Open once, bind fstat identity before any content read, then read to EOF under
   * an actual byte ceiling. Reject observed growth, truncation and replacements.
   */
  readFileBytes(absolutePath: string, maxBytes: number): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferConstants.MAX_LENGTH) {
      throw new RangeError('maxBytes must be a non-negative supported Buffer length');
    }
    const checked = this.#walk(this.relativize(absolutePath));
    if (checked.entry.kind !== 'file') return fail('not_regular_file', absolutePath);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const descriptor = fs.openSync(checked.entry.absolutePath, flags);
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile()) return fail('not_regular_file', absolutePath);
      if (!unchanged(checked.chain.at(-1)!.stats, before)) return fail('changed', absolutePath);
      this.#checked(() => checkChain(checked.chain));
      if (before.size > BigInt(maxBytes)) return fail('too_large', absolutePath);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1 - total));
        const count = fs.readSync(descriptor, chunk, 0, chunk.length, total);
        if (count === 0) break;
        total += count;
        if (total > maxBytes) return fail('too_large', absolutePath);
        chunks.push(chunk.subarray(0, count));
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (!unchanged(before, after) || after.size !== BigInt(total)) return fail('changed', absolutePath);
      this.#checked(() => checkChain(checked.chain));
      if (!unchanged(after, metadata(checked.entry.absolutePath))) return fail('changed', absolutePath);
      return Buffer.concat(chunks, total);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}
