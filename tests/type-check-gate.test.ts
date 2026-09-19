import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { repoRoot } from './helpers/cli-runner.ts';

/**
 * JG-001 acceptance criterion: a type error must fail the type check with a non-zero
 * exit code, and `npm run typecheck` (the documented command) must propagate that code.
 *
 * The deliberate error is written to tests/__type_check_gate__.ts, never to src/:
 * tests/ is inside tsconfig.json but outside tsconfig.build.json, so a killed run can
 * never break `npm run build` or ship a broken file in dist/. The artifact is also not
 * gitignored, states what it is, and is deleted again at the start of the next run.
 */
const gateFile = join(repoRoot, 'tests', '__type_check_gate__.ts');
const tscEntry = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Locate the npm CLI script that ships with this Node.js installation, so the documented
 * `npm run typecheck` can be spawned without a shell (a shell on Windows would also emit
 * the DEP0190 deprecation warning, and .cmd files cannot be spawned without one).
 */
function npmCliScript(): string | undefined {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function runNpmScript(script: string): CommandResult {
  const cli = npmCliScript();
  if (cli !== undefined) {
    return run(process.execPath, [cli, 'run', script], false);
  }
  // Fallback for installations that keep npm elsewhere: go through the shell.
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const gateSource = `// Leftover artifact of tests/type-check-gate.test.ts: this file deliberately does not
// type check. It is deleted automatically by the next \`npm test\`, and you can delete it
// by hand at any time. It never reaches dist/, because tsconfig.build.json only includes src/.
export const wrong: string = 1;
`;

before(() => {
  if (existsSync(gateFile)) {
    process.stderr.write(`type-check-gate: removing a leftover ${gateFile} from an interrupted run\n`);
    rmSync(gateFile, { force: true });
  }
});

after(() => {
  rmSync(gateFile, { force: true });
});

type CommandResult = {
  readonly code: number | null;
  readonly output: string;
};

function run(command: string, args: readonly string[], shell: boolean): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function projectTypeCheck(): CommandResult {
  return run(process.execPath, [tscEntry, '-p', join(repoRoot, 'tsconfig.json')], false);
}

test('the untouched project passes its own type check', { timeout: 300_000 }, () => {
  const result = projectTypeCheck();
  assert.equal(result.code, 0, `the project must type check cleanly:\n${result.output}`);
});

test('a type error fails the project type check with a non-zero code', { timeout: 300_000 }, () => {
  writeFileSync(gateFile, gateSource, 'utf8');
  try {
    const direct = projectTypeCheck();
    assert.notEqual(direct.code, 0, 'a deliberate type error must fail the type check');
    assert.match(direct.output, /__type_check_gate__/);
    assert.match(direct.output, /error TS\d+/);

    // The documented command must propagate the failure, otherwise the acceptance
    // criterion only holds for the raw compiler invocation.
    const viaScript = runNpmScript('typecheck');
    assert.notEqual(viaScript.code, 0, `npm run typecheck must exit non-zero:\n${viaScript.output}`);

    // …and the error must never poison the build configuration, which only includes src/.
    const build = run(process.execPath, [tscEntry, '-p', join(repoRoot, 'tsconfig.build.json'), '--noEmit'], false);
    assert.equal(build.code, 0, `the gate artifact must not break the build config:\n${build.output}`);
  } finally {
    rmSync(gateFile, { force: true });
  }
});

test('the gate artifact is not hidden from git', () => {
  const ignoreRules = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
  assert.doesNotMatch(
    ignoreRules,
    /__type_check_gate__/,
    'a leftover gate artifact must stay visible in git status',
  );
});
