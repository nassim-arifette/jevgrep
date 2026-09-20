/** Guarded local state outside source trees; observable replacement invalidates access. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AuthorizedRoot, UnauthorizedPathError, assertSafeRelativePath } from './source/authorization.ts';

export function isMissing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
    || (cause instanceof UnauthorizedPathError && cause.refusal === 'missing');
}

export class LocalDirectory {
  readonly path: string;
  readonly #ancestor: AuthorizedRoot;
  readonly #suffix: readonly string[];
  #root: AuthorizedRoot | undefined;
  #checkedLockCandidates = false;

  constructor(path: string, excludedRoot?: AuthorizedRoot) {
    let existing = resolve(path);
    const suffix: string[] = [];
    for (;;) {
      try { fs.lstatSync(existing); break; }
      catch (cause) { if (!isMissing(cause)) throw cause; }
      suffix.unshift(assertSafeRelativePath(basename(existing)));
      const parent = dirname(existing);
      if (parent === existing) throw new Error('local state ancestor is unavailable');
      existing = parent;
    }
    this.#ancestor = AuthorizedRoot.open(existing);
    this.#suffix = suffix;
    this.path = join(this.#ancestor.path, ...suffix);
    if (excludedRoot?.contains(this.path)) throw new Error('local configuration, secrets and cache must be outside the repository');
    if (suffix.length === 0) this.#root = this.#ancestor;
  }

  root(create = false): AuthorizedRoot {
    this.#ancestor.assertCurrent();
    if (this.#root !== undefined) { this.#root.assertCurrent(); return this.#root; }
    let current = '';
    for (const segment of this.#suffix) {
      current = current === '' ? segment : `${current}/${segment}`;
      try { this.#ancestor.resolveEntry(current); }
      catch (cause) {
        if (!create || !isMissing(cause)) throw cause;
        this.#ancestor.assertCurrent();
        fs.mkdirSync(join(this.#ancestor.path, current), { mode: 0o700 });
        this.#ancestor.resolveEntry(current);
      }
    }
    this.#root = AuthorizedRoot.open(this.path);
    this.#ancestor.assertCurrent();
    return this.#root;
  }

  read(relative: string, maxBytes: number): Buffer {
    const root = this.root();
    return root.readFileBytes(join(root.path, assertSafeRelativePath(relative)), maxBytes);
  }

  write(relative: string, text: string, exclusive = false): void {
    const name = assertSafeRelativePath(relative);
    const root = this.root(true);
    const parts = name.split('/'); parts.pop();
    let parent = '';
    for (const part of parts) {
      parent = parent === '' ? part : `${parent}/${part}`;
      try { root.resolveEntry(parent); }
      catch (cause) {
        if (!isMissing(cause)) throw cause;
        root.assertCurrent(); fs.mkdirSync(join(root.path, parent), { mode: 0o700 }); root.resolveEntry(parent);
      }
    }
    const parentRoot = AuthorizedRoot.open(join(root.path, parent));
    const target = basename(name);
    try {
      parentRoot.resolveEntry(target);
      if (exclusive) throw new Error('local state file already exists');
    } catch (cause) { if (!isMissing(cause)) throw cause; }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const temporaryPath = join(parentRoot.path, temporary);
    const fd = fs.openSync(temporaryPath, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, text, 'utf8');
        const descriptor = fs.fstatSync(fd, { bigint: true });
        const entry = parentRoot.resolveEntry(temporary);
        const named = fs.lstatSync(entry.absolutePath, { bigint: true });
        if (descriptor.dev !== named.dev || descriptor.ino !== named.ino) throw new Error('local state file changed during write');
      } finally { fs.closeSync(fd); }
      root.assertCurrent(); parentRoot.assertCurrent();
      if (exclusive) {
        // Publish complete bytes without replacing an existing target.
        fs.linkSync(temporaryPath, join(parentRoot.path, target));
      } else {
        try { parentRoot.resolveEntry(target); } catch (cause) { if (!isMissing(cause)) throw cause; }
        fs.renameSync(temporaryPath, join(parentRoot.path, target));
      }
      root.assertCurrent(); parentRoot.assertCurrent();
    } finally {
      try { parentRoot.resolveEntry(temporary); parentRoot.assertCurrent(); fs.unlinkSync(temporaryPath); }
      catch (cause) { if (!isMissing(cause)) throw cause; }
    }
  }

  remove(relative: string): boolean {
    try {
      const root = this.root(); const name = assertSafeRelativePath(relative);
      const parent = AuthorizedRoot.open(join(root.path, dirname(name)));
      const entry = root.resolveEntry(name);
      if (entry.kind !== 'file') return false;
      root.assertCurrent(); parent.assertCurrent(); fs.unlinkSync(entry.absolutePath);
      root.assertCurrent(); parent.assertCurrent(); return true;
    } catch (cause) { if (isMissing(cause)) return false; throw cause; }
  }

  /** Nonblocking writer lock. Contention degrades cache reuse instead of delaying a search. */
  withLock<T>(operation: () => T): T {
    const root = this.root(true);
    if (!this.#checkedLockCandidates) { this.#cleanLockCandidates(); this.#checkedLockCandidates = true; }
    const marker = `${String(process.pid)}-${randomUUID()}.owner`;
    const temporary = `.lock-${marker}`;
    const lockPath = join(root.path, '.write.lock');
    const candidatePath = join(root.path, temporary);
    root.assertCurrent(); fs.mkdirSync(candidatePath, { mode: 0o700 });
    let published = false;
    try {
      this.write(`${temporary}/${marker}`, marker, true);
      root.assertCurrent();
      try { fs.renameSync(candidatePath, lockPath); }
      catch {
        this.#recoverLock();
        root.assertCurrent(); fs.renameSync(candidatePath, lockPath);
      }
      published = true;
      root.assertCurrent(); this.read(`.write.lock/${marker}`, 128);
      return operation();
    } finally {
      // A late releaser knows only its own generation; it cannot unlink a new
      // owner's marker. rmdir checks emptiness atomically, without recursion.
      const name = published ? '.write.lock' : temporary;
      this.remove(`${name}/${marker}`);
      try {
        const directory = AuthorizedRoot.open(join(root.path, name));
        root.assertCurrent(); directory.assertCurrent(); fs.rmdirSync(directory.path);
      } catch (cause) {
        if (!isMissing(cause) && !['ENOTEMPTY', 'EEXIST'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
      }
    }
  }

  #recoverLock(): void {
    const root = this.root();
    const path = join(root.path, '.write.lock');
    let lock: AuthorizedRoot;
    try { lock = AuthorizedRoot.open(path); } catch (cause) { if (isMissing(cause)) return; throw cause; }
    const entries = fs.readdirSync(lock.path);
    lock.assertCurrent();
    if (entries.length === 1) {
      const marker = entries[0]!;
      const match = /^([1-9][0-9]*)-[0-9a-f-]{36}\.owner$/.exec(marker);
      if (match === null || this.read(`.write.lock/${marker}`, 128).toString('utf8') !== marker) throw new Error('cache writer lock is unavailable');
      try { process.kill(Number(match[1]), 0); throw new Error('cache writer lock is busy'); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause; }
      lock.assertCurrent(); this.remove(`.write.lock/${marker}`);
    } else if (entries.length !== 0) throw new Error('cache writer lock is unavailable');
    // If another owner published a nonempty directory, this cannot remove it.
    root.assertCurrent(); lock.assertCurrent(); fs.rmdirSync(path);
  }

  #cleanLockCandidates(): void {
    const root = this.root();
    for (const name of fs.readdirSync(root.path)) {
      const match = /^\.lock-([1-9][0-9]*)-[0-9a-f-]{36}\.owner$/.exec(name);
      if (match === null) continue;
      try {
        try { process.kill(Number(match[1]), 0); continue; }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        const candidate = AuthorizedRoot.open(join(root.path, name));
        const marker = name.slice('.lock-'.length);
        const files = fs.readdirSync(candidate.path);
        if (files.length > 2 || files.some((file) => file !== marker && !(file.startsWith(`${marker}.`) && /^[0-9a-f-]{36}\.tmp$/.test(file.slice(marker.length + 1))))) continue;
        for (const file of files) { candidate.assertCurrent(); this.remove(`${name}/${file}`); }
        root.assertCurrent(); candidate.assertCurrent(); fs.rmdirSync(candidate.path);
      } catch { /* Unknown or concurrently changed state remains untouched. */ }
    }
  }
}
