import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuthorizedRoot, UnauthorizedPathError, assertSafeRelativePath } from '../src/source/authorization.ts';
import { assertNoReparsePoints, AttributeCheckError } from '../src/source/windows-attributes.ts';
import { ATTRIBUTE_STARTUP_TIMEOUT_MS, ATTRIBUTE_WORKER_GRACE_MS } from '../src/source/windows-attributes-timeouts.ts';
import { inventoryScope } from '../src/source/inventory.ts';
import { createDefaultConfiguration, loadConfiguration } from '../src/config.ts';

const temporary: string[] = [];
function fixture(): { directory: string; root: string; outside: string; file: string } {
  const directory = fs.mkdtempSync(join(tmpdir(), 'jevgrep-root-control-'));
  temporary.push(directory);
  const root = join(directory, 'repo');
  const outside = join(directory, 'repo-other');
  fs.mkdirSync(join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  const file = join(root, 'src', 'a.ts');
  fs.writeFileSync(file, 'authorized bytes\n');
  fs.writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SENTINEL');
  return { directory, root, outside, file };
}

after(() => {
  for (const directory of temporary) {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    assert.ok(basename(directory).startsWith('jevgrep-root-control-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const options = { respectGitignore: true, maxFileBytes: 1_048_576, extraDenyGlobs: [] };
const refused = (reason: string) => (error: unknown): boolean =>
  error instanceof UnauthorizedPathError && error.refusal === reason;

test('every lexical rejection in the junior fixture table reaches the real reader before filesystem access', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const table = JSON.parse(fs.readFileSync(new URL('./fixtures/authorization/scope-cases.json', import.meta.url), 'utf8')) as {
    cases: { form: string; expect: string; reason?: string; target?: string }[];
  };
  const stat = t.mock.method(fs, 'lstatSync');
  const read = t.mock.method(fs, 'readSync');
  for (const entry of table.cases) {
    if (entry.form !== 'scope' || entry.expect !== 'reject' || entry.reason === 'link') continue;
    assert.throws(() => root.resolveEntry(entry.target ?? ''), refused('unsupported_path_syntax'), entry.target);
  }
  for (const path of ['NUL.txt', 'a/COM1', 'a.', 'a ', 'a\nfile', '../repo-other/secret.txt']) {
    assert.throws(() => root.resolveEntry(path), refused('unsupported_path_syntax'));
  }
  assert.equal(stat.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(assertSafeRelativePath('.//src\\a.ts'), 'src/a.ts');
});

test('a same-prefix sibling never reaches open or read', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const open = t.mock.method(fs, 'openSync');
  const read = t.mock.method(fs, 'readSync');
  assert.throws(() => root.readFileBytes(join(space.outside, 'secret.txt'), 100), refused('outside_root'));
  assert.equal(open.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test('a root replaced by another directory at the same path invalidates the retained authorization', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  fs.renameSync(space.root, join(space.directory, 'old-root'));
  fs.mkdirSync(join(space.root, 'src'), { recursive: true });
  fs.writeFileSync(space.file, 'REPLACEMENT');
  const read = t.mock.method(fs, 'readSync');
  assert.throws(() => root.resolveEntry('.'), refused('changed'));
  assert.throws(() => root.readDirectory('.'), refused('changed'));
  assert.throws(() => root.readFileBytes(space.file, 100), refused('changed'));
  assert.equal(read.mock.callCount(), 0);
  fs.renameSync(space.root, join(space.directory, 'replacement-root'));
  fs.renameSync(join(space.directory, 'old-root'), space.root);
  assert.throws(() => root.assertCurrent(), refused('changed'));
});

test('an anchor mismatch observed by a post-open check stays invalid after restoration', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const open = fs.openSync;
  let opened = false;
  let observed = false;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = open(path, flags, mode);
    if (String(path) === space.file) opened = true;
    return fd;
  });
  t.mock.method(fs, 'lstatSync', new Proxy(fs.lstatSync, {
    apply(target, receiver, args) {
      const stats = Reflect.apply(target, receiver, args) as fs.BigIntStats;
      if (opened && !observed && String(args[0]) === space.root) {
        observed = true;
        return new Proxy(stats, { get: (value, key) => key === 'ino' ? value.ino + 1n : Reflect.get(value, key) });
      }
      return stats;
    },
  }));
  const read = t.mock.method(fs, 'readSync');
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => root.readFileBytes(space.file, 100), refused('changed'));
  assert.ok(observed);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
  assert.throws(() => root.assertCurrent(), refused('changed'));
});

test('a substituted regular file is rejected by descriptor identity before its first content read', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (String(path) === space.file && !replaced) {
      replaced = true;
      fs.renameSync(space.file, join(space.directory, 'original-file'));
      fs.linkSync(join(space.outside, 'secret.txt'), space.file);
    }
    return open(path, flags, mode);
  });
  const read = t.mock.method(fs, 'readSync');
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => root.readFileBytes(space.file, 100), refused('changed'));
  assert.ok(replaced);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
});

test('a linked root observed during component validation stays invalid after restoration', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const original = join(space.directory, 'original-root');
  let replaced = false;
  t.mock.method(fs, 'lstatSync', new Proxy(fs.lstatSync, {
    apply(target, receiver, args) {
      const stats = Reflect.apply(target, receiver, args) as fs.BigIntStats;
      if (!replaced && String(args[0]) === space.root) {
        replaced = true;
        fs.renameSync(space.root, original);
        fs.symlinkSync(original, space.root, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return stats;
    },
  }));
  const read = t.mock.method(fs, 'readSync');
  assert.throws(() => root.resolveEntry('src/a.ts'), (error: unknown) =>
    error instanceof UnauthorizedPathError && (error.refusal === 'link' || error.refusal === 'outside_root'));
  assert.ok(replaced);
  assert.equal(read.mock.callCount(), 0);
  fs.unlinkSync(space.root);
  fs.renameSync(original, space.root);
  assert.throws(() => root.assertCurrent(), refused('changed'));
});

test('replacement of the root after open is detected before reading the descriptor', {
  skip: process.platform === 'win32' ? 'Windows refuses renaming this directory while the file is open; exercised on POSIX' : false,
}, (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = open(path, flags, mode);
    if (String(path) === space.file && !replaced) {
      replaced = true;
      fs.renameSync(space.root, join(space.directory, 'old-root'));
      fs.mkdirSync(join(space.root, 'src'), { recursive: true });
      fs.writeFileSync(space.file, 'REPLACEMENT');
    }
    return fd;
  });
  const read = t.mock.method(fs, 'readSync');
  const close = t.mock.method(fs, 'closeSync');
  assert.throws(() => root.readFileBytes(space.file, 100), refused('changed'));
  assert.equal(read.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
});

test('short reads are continued until EOF and maxBytes is a checked actual byte ceiling', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number) =>
    read(fd, buffer, offset, Math.min(2, length), position)) as typeof fs.readSync);
  assert.equal(root.readFileBytes(space.file, 17).toString(), 'authorized bytes\n');
  assert.throws(() => root.readFileBytes(space.file, 3), refused('too_large'));
  for (const limit of [-1, NaN, Infinity, 0.5]) assert.throws(() => root.readFileBytes(space.file, limit), RangeError);
  fs.writeFileSync(space.file, '');
  assert.equal(root.readFileBytes(space.file, 0).length, 0);
});

test('growth during a read never returns the original-size prefix as a complete snapshot', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const read = fs.readSync;
  let grew = false;
  t.mock.method(fs, 'readSync', ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number) => {
    if (!grew) { grew = true; fs.appendFileSync(space.file, 'more'); }
    return read(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
  assert.throws(() => root.readFileBytes(space.file, 100), refused('changed'));
});

test('directory links are refused as a root, an ancestor, an inventory entry and a read', () => {
  const space = fixture();
  const link = join(space.root, 'outside');
  fs.symlinkSync(space.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const root = AuthorizedRoot.open(space.root);
  assert.throws(() => AuthorizedRoot.open(link), refused('link'));
  assert.throws(() => AuthorizedRoot.open(join(link, 'nested')), refused('link'));
  assert.throws(() => root.resolveEntry('outside/secret.txt'), refused('link'));
  assert.throws(() => root.resolveEntry('outside/secret.txt'), (error: unknown) =>
    error instanceof UnauthorizedPathError && error.refusal === 'link' && error.requestedPath === link);
  assert.throws(() => root.readFileBytes(join(link, 'secret.txt'), 100), refused('link'));
  const inventory = inventoryScope(root, ['.'], options);
  assert.deepEqual(inventory.files.map((entry) => entry.relativePath), ['src/a.ts']);
  assert.ok(inventory.excluded.some((entry) => entry.reason === 'link')
    || inventory.excludedDirectories.some((entry) => entry.reason === 'link'));
});

test('a linked ignore file is not read and cannot silently disable exclusions', (t) => {
  const space = fixture();
  const outsideIgnore = join(space.outside, 'policy');
  fs.writeFileSync(outsideIgnore, 'src/\n');
  try { fs.symlinkSync(outsideIgnore, join(space.root, '.gitignore'), 'file'); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EPERM') { t.skip('file symlink creation requires host privilege'); return; }
    throw cause;
  }
  const root = AuthorizedRoot.open(space.root);
  const read = t.mock.method(fs, 'readSync');
  const inventory = inventoryScope(root, ['.'], options);
  assert.equal(inventory.complete, false);
  assert.equal(inventory.files.length, 0);
  assert.equal(read.mock.callCount(), 0);
});

test('case aliases follow filesystem identity and hard-link names remain distinct', () => {
  const space = fixture();
  fs.linkSync(space.file, join(space.root, 'src', 'hard.ts'));
  const root = AuthorizedRoot.open(space.root);
  assert.notEqual(root.identityKey(space.file), root.identityKey(join(space.root, 'src', 'hard.ts')));
  const same = inventoryScope(root, ['src', 'src/a.ts'], options);
  assert.equal(same.files.length, 2);
  if (process.platform === 'win32') {
    assert.equal(root.resolveEntry('SRC/A.TS').absolutePath, root.resolveEntry('src/a.ts').absolutePath);
  }
});

test('case-sensitive directories keep distinct case-only names and sibling roots separate', (t) => {
  const space = fixture();
  const parent = join(space.directory, 'case-sensitive');
  fs.mkdirSync(parent);
  if (process.platform === 'win32') {
    const fsutil = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'fsutil.exe');
    const enabled = spawnSync(fsutil, ['file', 'setCaseSensitiveInfo', parent, 'enable'], {
      windowsHide: true, encoding: 'utf8', timeout: 5_000,
    });
    if (enabled.status !== 0) { t.skip('host cannot enable per-directory Windows case sensitivity'); return; }
  }
  const lower = join(parent, 'repo');
  const upper = join(parent, 'REPO');
  fs.mkdirSync(lower);
  fs.mkdirSync(upper);
  fs.writeFileSync(join(lower, 'a.ts'), 'lower');
  fs.writeFileSync(join(lower, 'A.ts'), 'upper');
  fs.writeFileSync(join(upper, 'outside.ts'), 'OUTSIDE_SENTINEL');
  const root = AuthorizedRoot.open(lower);
  assert.deepEqual(inventoryScope(root, ['.'], options).files.map((entry) => entry.relativePath), ['A.ts', 'a.ts']);
  assert.notEqual(root.identityKey(join(lower, 'A.ts')), root.identityKey(join(lower, 'a.ts')));
  assert.throws(() => root.readFileBytes(join(upper, 'outside.ts'), 100), refused('outside_root'));
});

test('Windows rejects a non-symlink reparse tag before asking Node to inspect or read it', { skip: process.platform !== 'win32' }, (t) => {
  const space = fixture();
  const file = join(space.root, 'generic.ts');
  const system = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
  const helper = fileURLToPath(new URL('./helpers/reparse-fixture.ps1', import.meta.url));
  const run = (remove: boolean) => spawnSync(join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-Target', file, ...(remove ? ['-Remove'] : [])],
    { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  const created = run(false);
  assert.equal(created.status, 0, created.stderr);
  if (created.stdout.trim() === '5' || created.stdout.trim() === '1314') {
    t.skip('host lacks permission to create a non-Microsoft reparse fixture'); return;
  }
  assert.equal(created.stdout.trim(), '0');
  try {
    const tag = spawnSync(join(system, 'fsutil.exe'), ['reparsepoint', 'query', file], {
      windowsHide: true, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(tag.status, 0, tag.stdout + tag.stderr);
    assert.match(tag.stdout, /0x00000042/i);
    const root = AuthorizedRoot.open(space.root);
    const stat = t.mock.method(fs, 'lstatSync');
    const read = t.mock.method(fs, 'readSync');
    assert.throws(() => root.resolveEntry('generic.ts'), refused('link'));
    assert.throws(() => root.readFileBytes(file, 100), refused('link'));
    assert.equal(stat.mock.calls.some((call) => String(call.arguments[0]) === file), false);
    assert.equal(read.mock.callCount(), 0);
    const inventory = inventoryScope(root, ['.'], options);
    assert.ok(!inventory.files.some((entry) => entry.relativePath === 'generic.ts'));
  } finally {
    const removed = run(true);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout.trim(), '0', 'the fixture reparse tag must be removed before temporary-directory cleanup');
  }
});

test('path names with Unicode and shell metacharacters remain literal data', () => {
  const space = fixture();
  const name = 'été $() `literal` 漢字.ts';
  fs.writeFileSync(join(space.root, name), 'literal bytes');
  const root = AuthorizedRoot.open(space.root);
  assert.equal(root.readFileBytes(root.resolveEntry(name).absolutePath, 100).toString(), 'literal bytes');
});

test('the configuration retains its root identity across searches and rejects linked cache ancestors', () => {
  const space = fixture();
  const path = join(space.directory, 'config.json');
  const config = createDefaultConfiguration(space.root.replaceAll('\\', '/'), 'synthetic-model');
  fs.writeFileSync(path, JSON.stringify(config));
  const loaded = loadConfiguration(path, { env: { JEVGREP_CACHE_HOME: join(space.directory, 'cache') } });
  fs.renameSync(space.root, join(space.directory, 'old-root'));
  fs.mkdirSync(space.root);
  assert.throws(() => loaded.sourceRoot.resolveEntry('.'), refused('changed'));
  fs.symlinkSync(space.root, join(space.directory, 'cache-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => loadConfiguration(path, { env: { JEVGREP_CACHE_HOME: join(space.directory, 'cache-link') } }), /INVALID_CONFIG/);
  const absentTarget = join(space.root, 'cache-not-created');
  fs.symlinkSync(absentTarget, join(space.directory, 'dangling-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => loadConfiguration(path, { env: { JEVGREP_CACHE_HOME: join(space.directory, 'dangling-cache') } }), /INVALID_CONFIG/);
});

test('a disappeared listed file makes the inventory incomplete', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  const readDirectory = root.readDirectory.bind(root);
  t.mock.method(root, 'readDirectory', (path: string) => {
    const entries = readDirectory(path);
    if (path === 'src') fs.unlinkSync(space.file);
    return entries;
  });
  const result = inventoryScope(root, ['.'], options);
  assert.equal(result.complete, false);
  assert.equal(result.files.length, 0);
});

test('replacement during filesystem alias resolution makes inventory incomplete without throwing', (t) => {
  const space = fixture();
  const root = AuthorizedRoot.open(space.root);
  t.mock.method(root, 'identityKey', () => {
    throw new UnauthorizedPathError('changed', space.file, 'fixture substitution');
  });
  const result = inventoryScope(root, ['.'], options);
  assert.equal(result.complete, false);
  assert.equal(result.files.length, 0);
  assert.equal(result.traversalErrors, 1);
});

test('an observed ignore file disappearing before its read cannot authorize the scan', (t) => {
  const space = fixture();
  fs.writeFileSync(join(space.root, '.gitignore'), 'src/\n');
  const root = AuthorizedRoot.open(space.root);
  const read = root.readFileBytes.bind(root);
  t.mock.method(root, 'readFileBytes', (path: string, limit: number) => {
    if (basename(path) === '.gitignore') fs.unlinkSync(path);
    return read(path, limit);
  });
  const result = inventoryScope(root, ['.'], options);
  assert.equal(result.complete, false);
  assert.equal(result.files.length, 0);
});

test('an invalid Windows path refuses only that request and leaves the helper usable', { skip: process.platform !== 'win32' }, () => {
  const space = fixture();
  assertNoReparsePoints([space.root]);
  assert.throws(() => assertNoReparsePoints([join(space.root, 'a'.repeat(300))]), AttributeCheckError);
  assertNoReparsePoints([space.root]);
  assert.equal(AuthorizedRoot.open(space.root).readFileBytes(space.file, 100).toString(), 'authorized bytes\n');
});

test('an unavailable Windows attribute helper refuses access and exits without raw diagnostics', { skip: process.platform !== 'win32' }, () => {
  const space = fixture();
  const module = new URL('../src/source/windows-attributes.ts', import.meta.url).href;
  const script = `import { assertNoReparsePoints } from ${JSON.stringify(module)};
    process.env.SystemRoot = process.argv[2];
    try { assertNoReparsePoints([process.argv[1]]); process.exitCode=2; }
    catch(e) { if(e.kind !== 'unavailable') throw e; }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, space.root, join(space.directory, 'missing-windows')], {
    windowsHide: true, encoding: 'utf8',
    timeout: ATTRIBUTE_STARTUP_TIMEOUT_MS + ATTRIBUTE_WORKER_GRACE_MS + 5_000,
    cwd: fileURLToPath(new URL('../', import.meta.url)),
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});
