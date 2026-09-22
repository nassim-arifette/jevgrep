import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfiguration, loadConfiguration } from '../../src/config.ts';
import type { Configuration } from '../../src/contracts.ts';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const fixtureRoot = join(projectRoot, 'tests/fixtures/repositories');

export function positiveInteger(value: string | undefined, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('expected a positive integer');
  return result;
}

/** Fixture inputs are versioned, original synthetic sources, never a user's repo. */
export function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('benchmark input must not contain links');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files[relative(root, path).split(sep).join('/')] = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
      else throw new Error('benchmark input must contain only regular files');
    }
  };
  walk(root);
  return files;
}

/** Canonical LF content and sorted paths make fixture identities cross-platform. */
export function treeHash(files: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
}

export function workspace(files: Readonly<Record<string, string>>, configure?: (base: Configuration) => Configuration) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jevgrep-bench-')));
  const repository = join(root, 'repository');
  mkdirSync(repository);
  const write = (path: string, text: string): void => {
    const absolute = resolve(repository, path);
    const local = relative(repository, absolute);
    if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('invalid fixture path');
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  };
  // Capture and check the owned temporary path before any recursive cleanup.
  const cleanup = (): void => {
    const local = relative(realpathSync.native(tmpdir()), root);
    if (local.startsWith('..') || isAbsolute(local) || !local.startsWith('jevgrep-bench-') || local.includes(sep)) {
      throw new Error('refusing cleanup outside the owned benchmark directory');
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    for (const [path, text] of Object.entries(files)) write(path, text);
    const base = createDefaultConfiguration(repository.split(sep).join('/'), 'jev-1.13.0');
    const config = configure?.(base) ?? base;
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    const env = { JEVGREP_CACHE_HOME: join(root, 'cache') };
    return { repository, write, cleanup, loaded: loadConfiguration(configPath, { env }) };
  } catch (cause) {
    cleanup();
    throw cause;
  }
}

export function environment() {
  const git = (...args: string[]): string | null => {
    try { return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return null; }
  };
  const harness = readTree(join(projectRoot, 'scripts/bench'));
  for (const name of ['bench.ts', 'bench-retrieval.ts']) {
    harness[`entry/${name}`] = readFileSync(join(projectRoot, 'scripts', name), 'utf8').replaceAll('\r\n', '\n');
  }
  return {
    node: process.version, platform: process.platform, architecture: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, totalMemoryBytes: totalmem(),
    revision: git('rev-parse', 'HEAD'), workingTree: git('status', '--porcelain'),
    sourceHash: treeHash(readTree(join(projectRoot, 'src'))),
    harnessHash: treeHash(harness),
    packageLockHash: createHash('sha256').update(readFileSync(join(projectRoot, 'package-lock.json'))).digest('hex'),
  };
}

export function writeReport(output: string, report: unknown): string {
  const path = resolve(output);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
