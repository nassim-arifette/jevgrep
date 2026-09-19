import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { repoRoot } from './helpers/cli-runner.ts';

/**
 * JG-026 acceptance: the versioned local artifact must install into a clean prefix and run
 * there, without the repository, without a provider credential and without fetching an
 * unpinned version at start-up.
 *
 * The test packs the real package, installs the tarball into a temporary prefix and drives the
 * installed executable. It is the automated half of "a clean install follows the guide"; the
 * real Codex host run and the client time-out margin stay operator evidence.
 */
const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** npm ships with Node; run its CLI script directly so no shell is involved. */
function npmCli(): string {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found !== undefined, 'the npm CLI script must be discoverable next to node');
  return found;
}

type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

function run(command: string, args: readonly string[], cwd: string): RunResult {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function npm(args: readonly string[], cwd: string): RunResult {
  return run(process.execPath, [npmCli(), ...args], cwd);
}

test('the packed artifact installs into a clean prefix and runs there', { timeout: 600_000 }, () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jevgrep-install-'));
  temporaryRoots.push(workspace);
  const packDir = join(workspace, 'pack');
  const prefix = join(workspace, 'prefix');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(prefix, { recursive: true });

  // 0. `npm test` may run before `npm run build` (that is the order in `verify`), so the test
  // produces the artifact it packs instead of assuming a previous build left dist/ behind.
  if (!existsSync(join(repoRoot, 'dist', 'cli.js'))) {
    const built = run(
      process.execPath,
      [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(repoRoot, 'tsconfig.build.json')],
      repoRoot,
    );
    assert.equal(built.code, 0, `the test must be able to build the artifact it packs:\n${built.stdout}${built.stderr}`);
  }

  // 1. Pack exactly what the manifest publishes.
  const packed = npm(['pack', '--pack-destination', packDir, '--json'], repoRoot);
  assert.equal(packed.code, 0, packed.stderr);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `expected one tarball, found ${tarballs.join(', ')}`);
  const tarball = join(packDir, tarballs[0] ?? '');

  // 2. Install it into an empty prefix, with no repository in sight.
  // `--offline` keeps the ordinary suite network-free: the pinned runtime dependency is
  // already in the npm cache, so nothing is fetched from the registry here.
  const installed = npm(
    ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tarball],
    workspace,
  );
  assert.equal(installed.code, 0, installed.stderr);

  const packageRoot = join(prefix, 'node_modules', 'jevgrep');
  assert.equal(existsSync(join(packageRoot, 'dist', 'cli.js')), true, 'the artifact must ship the built entry point');
  const shipped = readdirSync(packageRoot).sort();
  assert.ok(shipped.includes('dist'), 'the artifact ships the build output');
  assert.ok(shipped.includes('package.json'), 'the artifact ships its manifest');
  for (const forbidden of ['src', 'tests', 'benchmarks', 'docs', 'scripts', 'node_modules']) {
    assert.equal(
      shipped.includes(forbidden),
      false,
      `the artifact must not ship '${forbidden}': sources and fixtures are not part of the package`,
    );
  }

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    version?: string;
    dependencies?: Record<string, string>;
    bin?: Record<string, string>;
  };
  assert.equal(manifest.bin?.['jevgrep'], './dist/cli.js');
  // Start-up must never resolve an unpinned version: every declared dependency is exact.
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is not pinned: ${range}`);
  }

  // 3. Drive the installed executable, not the repository copy.
  const entry = join(packageRoot, 'dist', 'cli.js');
  const version = run(process.execPath, [entry, '--version'], workspace);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), `jevgrep ${manifest.version ?? ''}`);

  const help = run(process.execPath, [entry, '--help'], workspace);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^usage: jevgrep/);

  const doctor = run(process.execPath, [entry, 'doctor', '--config', 'missing.json'], workspace);
  assert.equal(doctor.code, 2, 'the command layer must be reachable from the installed artifact');
  assert.match(doctor.stderr, /config/i);
});
