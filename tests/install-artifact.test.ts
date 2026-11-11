import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SearchResult } from '../src/contracts.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';
import { offlineEnv, repoRoot } from './helpers/cli-runner.ts';

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
    ...(process.env['npm_execpath'] === undefined ? [] : [process.env['npm_execpath']]),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  assert.ok(found !== undefined, 'the npm CLI script must be supplied by npm_execpath or discoverable next to node');
  return found;
}

type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): RunResult {
  const result = spawnSync(command, [...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    env: { ...env, PATH: `${dirname(process.execPath)}${delimiter}${env['PATH'] ?? ''}` },
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function npm(args: readonly string[], cwd: string): RunResult {
  return run(process.execPath, [npmCli(), ...args], cwd);
}

test('the packed artifact installs into a clean prefix and runs there', { timeout: 600_000 }, () => {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'jevgrep-install-')));
  temporaryRoots.push(workspace);
  const packDir = join(workspace, 'pack');
  const prefix = join(workspace, 'prefix');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(prefix, { recursive: true });

  // 0. `npm test` may run before `npm run build` (that is the order in `verify`), so the test
  // produces the artifact it packs instead of assuming a previous build left dist/ behind.
  const built = npm(['run', 'build'], repoRoot);
  assert.equal(built.code, 0, `the test must be able to build the artifact it packs:\n${built.stdout}${built.stderr}`);

  // 1. Pack exactly what the manifest publishes.
  const packed = npm(['pack', '--pack-destination', packDir, '--json'], repoRoot);
  assert.equal(packed.code, 0, packed.stderr);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `expected one tarball, found ${tarballs.join(', ')}`);
  const tarball = join(packDir, tarballs[0] ?? '');

  // 2. Install it into an empty prefix, with no repository in sight.
  // `npm ci` caches tarballs but does not necessarily cache registry metadata. Seed
  // the installation's dependency graph from the same lockfile, so a clean CI host
  // can install offline without having run an unrelated `npm install` first.
  const installation = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  const packageName = installation['name'];
  assert.equal(typeof packageName, 'string');
  installation['name'] = 'jevgrep-artifact-install';
  delete installation['bin'];
  delete installation['scripts'];
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
    name: string; packages: Record<string, Record<string, unknown>>;
  };
  lock.name = 'jevgrep-artifact-install';
  lock.packages['']!['name'] = lock.name;
  delete lock.packages['']!['bin'];
  writeFileSync(join(prefix, 'package.json'), JSON.stringify(installation));
  writeFileSync(join(prefix, 'package-lock.json'), JSON.stringify(lock));
  const installed = npm(
    ['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tarball],
    workspace,
  );
  assert.equal(installed.code, 0, installed.stderr);

  const packageRoot = join(prefix, 'node_modules', packageName as string);
  assert.equal(existsSync(join(packageRoot, 'dist', 'cli.js')), true, 'the artifact must ship the built entry point');
  for (const language of ['go', 'rust']) {
    assert.equal(existsSync(join(packageRoot, 'dist', 'source', 'grammars', `tree-sitter-${language}.wasm`)), true,
      `the artifact must ship the ${language} grammar copied by the real build`);
  }
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
  assert.equal(manifest.bin?.['jevgrep'], 'dist/cli.js');
  // Start-up must never resolve an unpinned version: every declared dependency is exact.
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    assert.match(range, /^(?:npm:typescript@)?\d+\.\d+\.\d+$/, `${name} is not pinned: ${range}`);
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

  // 4. Exercise installed searches, including the lazy Go/Rust grammar loaders and
  // worker entry point. A scripted fetch replaces the provider; the offline guard
  // still blocks every network entry point and no real credential is inherited.
  const languages = {
    'languages/source.ts': 'export function answer(): number {\n  return 42;\n}\n',
    'languages/source.go': 'package example\n\nfunc Answer() int {\n  return 42\n}\n',
    'languages/source.rs': 'pub fn answer() -> i32 {\n    42\n}\n',
  };
  const large = 'This harmless source line exercises background preparation.\n'.repeat(10_500);
  assert.ok(Buffer.byteLength(large) * 2 > 1_048_576, 'the installed search must activate preparation workers');
  const space = createWorkspace({ files: { ...languages, 'large/a.txt': large, 'large/b.txt': large }, configure: withRemoteEnabled });
  try {
    const preload = join(workspace, 'scripted-provider.mjs');
    writeFileSync(preload, `globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({ model: request.model,
        answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) =>
          [key, { type: 'noul', noul: question.instructions.includes('File: languages/') ? 0.9 : 0 }])),
        usage: { input_tokens: 100, output_tokens: 0 } }));
    };\n`);
    const env = { ...offlineEnv(), ...space.env, JEVGREP_PREPARE_THREADS: '1', [space.loaded.config.provider.api_key_env]: 'synthetic-offline-key' };
    const inspected = run(process.execPath, [entry, 'inspect', '--config', space.configPath, '--scope', 'languages', '--json'], workspace, env);
    assert.equal(inspected.code, 0, inspected.stderr);
    const inspection = JSON.parse(inspected.stdout) as { files: { eligible: number }; fragments: { parse_fallbacks: number; by_strategy: Record<string, number> } };
    assert.equal(inspection.files.eligible, 3);
    assert.equal(inspection.fragments.parse_fallbacks, 0, inspected.stdout);
    assert.ok((inspection.fragments.by_strategy['syntax-range'] ?? 0) >= 3, inspected.stdout);

    for (const scope of ['languages', 'large']) {
      const searched = run(process.execPath, ['--import', pathToFileURL(preload).href, entry, 'search', '--config', space.configPath,
        '--scope', scope, '--query', 'Which function returns the answer?', '--json'], workspace, env);
      assert.equal(searched.code, 0, searched.stderr);
      const outcome = JSON.parse(searched.stdout) as SearchResult;
      assert.equal(outcome.report.scope_fully_scanned, true, searched.stdout);
      assert.equal(outcome.report.files.eligible, scope === 'languages' ? 3 : 2);
      assert.ok(outcome.report.usage.provider_request_attempts > 0, 'the installed package must reach the scripted provider');
      if (scope === 'languages') {
        assert.deepEqual(new Set(outcome.excerpts.map((excerpt) => excerpt.path)), new Set(Object.keys(languages)));
        for (const excerpt of outcome.excerpts) {
          const source = languages[excerpt.path as keyof typeof languages];
          assert.equal(excerpt.code, source.split('\n').slice(excerpt.start_line - 1, excerpt.end_line).join('\n') + '\n');
        }
      }
    }
  } finally { space.cleanup(); }
});
