import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalDirectory } from '../src/local-directory.ts';

test('a live writer remains exclusive, and an empty or dead generation is recoverable', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'jevgrep-local-lock-'));
  const storage = new LocalDirectory(directory); const second = new LocalDirectory(directory);
  try {
    storage.withLock(() => { assert.throws(() => second.withLock(() => assert.fail('two writers entered'))); });
    const lock = join(directory, '.write.lock'); fs.mkdirSync(lock);
    assert.equal(storage.withLock(() => 1), 1, 'empty abandoned directory is recoverable');
    fs.mkdirSync(lock);
    const marker = '999999-00000000-0000-0000-0000-000000000001.owner'; fs.writeFileSync(join(lock, marker), marker);
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    assert.equal(storage.withLock(() => 2), 2, 'dead owner is recoverable');
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a candidate abandoned before publication is cleaned after its publisher exits', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'jevgrep-lock-candidate-'));
  try {
    const marker = '999999-00000000-0000-0000-0000-000000000001.owner';
    const abandoned = join(directory, `.lock-${marker}`); fs.mkdirSync(abandoned);
    fs.writeFileSync(join(abandoned, `${marker}.00000000-0000-0000-0000-000000000002.tmp`), 'partial');
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    new LocalDirectory(directory).withLock(() => {});
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a delayed stale-generation remover cannot delete a new owner or enter its critical section', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'jevgrep-local-lock-race-'));
  const storage = new LocalDirectory(directory); const lock = join(directory, '.write.lock');
  const old = '999999-00000000-0000-0000-0000-000000000001.owner';
  const next = `${String(process.pid)}-00000000-0000-0000-0000-000000000002.owner`;
  try {
    fs.mkdirSync(lock); fs.writeFileSync(join(lock, old), old);
    t.mock.method(process, 'kill', () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    const rmdir = fs.rmdirSync; let replaced = false; let entered = false;
    t.mock.method(fs, 'rmdirSync', new Proxy(rmdir, { apply(target, receiver, args) {
      if (!replaced && String(args[0]) === lock) {
        replaced = true; Reflect.apply(target, receiver, args);
        fs.mkdirSync(lock); fs.writeFileSync(join(lock, next), next);
      }
      return Reflect.apply(target, receiver, args);
    } }));
    assert.throws(() => storage.withLock(() => { entered = true; }));
    assert.equal(entered, false); assert.equal(fs.readFileSync(join(lock, next), 'utf8'), next);
  } finally { t.mock.restoreAll(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed local writes close their handle and remove the temporary file', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'jevgrep-local-'));
  const storage = new LocalDirectory(directory);
  try {
    t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
    assert.throws(() => storage.write('entry.json', '{}'), /full/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a parent replaced between lookup and deletion cannot redirect an unlink', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'jevgrep-local-'));
  const storage = new LocalDirectory(directory);
  try {
    storage.write('shard/entry.json', '{}');
    const original = fs.lstatSync;
    let lookedUp = false;
    let unlinks = 0;
    t.mock.method(fs, 'lstatSync', new Proxy(original, { apply(target, receiver, args) {
      const stat = Reflect.apply(target, receiver, args) as fs.BigIntStats;
      if (String(args[0]) === join(directory, 'shard', 'entry.json')) lookedUp = true;
      if (lookedUp && String(args[0]) === join(directory, 'shard')) {
        return new Proxy(stat, { get: (value, key) => key === 'ino' ? value.ino + 1n : Reflect.get(value, key) });
      }
      return stat;
    } }));
    t.mock.method(fs, 'unlinkSync', () => { unlinks++; });
    assert.throws(() => storage.remove('shard/entry.json'));
    assert.equal(unlinks, 0);
  } finally { t.mock.restoreAll(); fs.rmSync(directory, { recursive: true, force: true }); }
});
