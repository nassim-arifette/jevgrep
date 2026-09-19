/**
 * Post-build smoke check for the packaged CLI (JG-001).
 *
 * It runs the emitted dist/cli.js exactly as an installed user would and checks the
 * documented exit codes, so `npm run verify` fails if the package stops being
 * executable or starts advertising commands it does not implement.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot: string = fileURLToPath(new URL('..', import.meta.url));
const entry: string = join(repoRoot, 'dist', 'cli.js');

type CheckResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
}

function run(args: readonly string[], cwd: string = repoRoot): CheckResult {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

if (!existsSync(entry)) {
  process.stderr.write(`smoke: ${entry} is missing; run 'npm run build' first\n`);
  process.exitCode = 1;
} else {
  const emitted = readFileSync(entry, 'utf8');
  record('dist/cli.js keeps its shebang', emitted.startsWith('#!/usr/bin/env node'), emitted.slice(0, 40));

  const help = run(['--help']);
  record('--help exits 0 with usage on stdout', help.code === 0 && help.stdout.startsWith('usage: jevgrep'), `code=${String(help.code)}`);

  const version = run(['--version']);
  record('--version exits 0 with one version line', version.code === 0 && /^jevgrep \d+\.\d+\.\d+\n$/.test(version.stdout), `code=${String(version.code)} out=${version.stdout.trim()}`);

  const fromElsewhere = run(['--version'], tmpdir());
  record('--version works outside the repository', fromElsewhere.code === 0 && fromElsewhere.stdout === version.stdout, `code=${String(fromElsewhere.code)}`);

  const search = run(['search', '--config', 'config.json', '--query', 'authorization']);
  record('search is rejected as not implemented', search.code === 69 && /not implemented in this build/.test(search.stderr) && search.stdout === '', `code=${String(search.code)}`);

  const unknown = run(['frobnicate']);
  record('an unknown command exits 2', unknown.code === 2 && /unknown command/.test(unknown.stderr), `code=${String(unknown.code)}`);

  const noArgs = run([]);
  record('no arguments exits 2', noArgs.code === 2 && /no command given/.test(noArgs.stderr), `code=${String(noArgs.code)}`);

  for (const check of checks) {
    const status = check.ok ? 'ok  ' : 'FAIL';
    const detail = check.detail.length > 0 ? ` (${check.detail})` : '';
    process.stdout.write(`smoke: ${status} ${check.name}${detail}\n`);
  }

  const failures = checks.filter((check) => !check.ok);
  if (failures.length > 0) {
    process.stderr.write(`smoke: ${String(failures.length)} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`smoke: all ${String(checks.length)} checks passed\n`);
  }
}
