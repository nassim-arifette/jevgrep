/**
 * Reproducible probe of the pinned TypeScript package's syntax APIs (JG-015).
 *
 * Compare the build compiler and the separately pinned runtime syntax parser.
 * The probe asks the installed packages which parse entry points exist and whether
 * they behave, and prints a machine-readable verdict.
 *
 * Each candidate runs in its **own child process**, because one of them has been
 * observed to abort the process rather than throw. A probe that dies with its subject
 * proves nothing, so the parent records the exit signal as the result.
 *
 * Usage:
 *   node scripts/probe-typescript-parser.ts            # human summary
 *   node scripts/probe-typescript-parser.ts --json     # machine-readable verdict
 *
 * Re-run it whenever either TypeScript version changes; the decision is recorded
 * during the syntax chunker investigation.
 */
import { spawnSync } from 'node:child_process';
import { argv, execPath, stdout, versions } from 'node:process';
import { fileURLToPath } from 'node:url';

/** The one sample every candidate must handle: comments, regex, template, class, JSX-free. */
export const PROBE_SOURCE = [
  '/** doc */',
  'export function handle(input) {',
  '  const pattern = /ab[/]c/g;',
  '  return `value:${String(input)}` + pattern.source;',
  '}',
  'class Registry { register(name) { this.items.push(name); } }',
  '',
].join('\n');

export type ProbeVerdict = {
  readonly candidate: string;
  /** `usable` means the API parsed the sample into plausible token or node positions. */
  readonly status: 'usable' | 'absent' | 'misbehaved' | 'crashed';
  readonly detail: string;
};

type CandidateName = 'classic-api' | 'pinned-parser-api' | 'unstable-ast-scanner' | 'unstable-sync-api';

const CANDIDATES: readonly CandidateName[] = ['classic-api', 'pinned-parser-api', 'unstable-ast-scanner', 'unstable-sync-api'];

/** Body executed inside the child process for one candidate. */
async function runCandidate(candidate: CandidateName): Promise<ProbeVerdict> {
  if (candidate === 'classic-api' || candidate === 'pinned-parser-api') {
    const module: Record<string, unknown> = candidate === 'classic-api' ? await import('typescript') : await import('typescript-parser');
    const api = (module['default'] ?? module) as Record<string, unknown>;
    if (typeof api['createSourceFile'] !== 'function') {
      return {
        candidate,
        status: 'absent',
        detail: `typescript@${String(api['version'] ?? 'unknown')} exports ${String(Object.keys(api).length)} `
          + `key(s) and no createSourceFile: ${Object.keys(api).slice(0, 8).join(', ')}`,
      };
    }
    const create = api['createSourceFile'] as (...args: unknown[]) => { statements?: { length?: number } };
    const target = (api['ScriptTarget'] as Record<string, unknown> | undefined)?.['Latest'];
    const source = create('probe.ts', PROBE_SOURCE, target, true);
    const statements = source.statements?.length ?? 0;
    return statements >= 2
      ? { candidate, status: 'usable', detail: `createSourceFile returned ${String(statements)} top-level statements` }
      : { candidate, status: 'misbehaved', detail: `createSourceFile returned ${String(statements)} statements for a 3-statement sample` };
  }

  if (candidate === 'unstable-ast-scanner') {
    const ast: Record<string, unknown> = await import('typescript/unstable/ast');
    if (typeof ast['createScanner'] !== 'function') {
      return { candidate, status: 'absent', detail: 'typescript/unstable/ast exports no createScanner' };
    }
    const createScanner = ast['createScanner'] as (...args: unknown[]) => Record<string, unknown>;
    const target = (ast['ScriptTarget'] as Record<string, unknown> | undefined)?.['Latest'];
    const variant = (ast['LanguageVariant'] as Record<string, unknown> | undefined)?.['Standard'];
    const scanner = createScanner(target, false, variant, PROBE_SOURCE);
    const scan = scanner['scan'] as (() => number) | undefined;
    const tokenStart = scanner['getTokenStart'] as (() => unknown) | undefined;
    const tokenEnd = scanner['getTokenEnd'] as (() => unknown) | undefined;
    if (typeof scan !== 'function' || typeof tokenStart !== 'function' || typeof tokenEnd !== 'function') {
      return { candidate, status: 'absent', detail: 'the scanner object exposes no scan/getTokenStart/getTokenEnd trio' };
    }

    const kinds: number[] = [];
    const starts: unknown[] = [];
    for (let index = 0; index < 6; index += 1) {
      kinds.push(scan());
      starts.push(tokenStart());
    }
    const distinctKinds = new Set(kinds).size;
    const offsetsAreNumbers = starts.every((value) => typeof value === 'number');
    const offsetsIncrease = offsetsAreNumbers
      && (starts as number[]).every((value, index) => index === 0 || value >= (starts[index - 1] as number));
    if (!offsetsAreNumbers) {
      return {
        candidate, status: 'misbehaved',
        detail: `getTokenStart() returned ${starts.map((value) => typeof value).join(', ')} instead of numbers`,
      };
    }
    if (distinctKinds <= 1 || !offsetsIncrease) {
      return {
        candidate, status: 'misbehaved',
        detail: `six scans produced ${String(distinctKinds)} distinct kind(s) and offsets ${starts.join(',')}`,
      };
    }
    return { candidate, status: 'usable', detail: `six scans produced ${String(distinctKinds)} distinct kinds with increasing offsets` };
  }

  const sync: Record<string, unknown> = await import('typescript/unstable/sync');
  const parseLike = Object.keys(sync).filter((key) => /parse|sourceFile|scan/i.test(key));
  return parseLike.length === 0
    ? {
      candidate, status: 'absent',
      detail: `typescript/unstable/sync exposes a project API (${Object.keys(sync).slice(0, 6).join(', ')}) and no syntax-only parse entry point`,
    }
    : { candidate, status: 'usable', detail: `syntax-capable exports: ${parseLike.join(', ')}` };
}

/** Run one candidate in a child process and turn any death into a verdict. */
export function probeCandidate(candidate: string): ProbeVerdict {
  const self = fileURLToPath(import.meta.url);
  const child = spawnSync(execPath, [self, '--child', candidate], { encoding: 'utf8', timeout: 30_000, windowsHide: true });

  if (child.signal !== null || (child.status !== 0 && child.stdout.trim().length === 0)) {
    return {
      candidate,
      status: 'crashed',
      detail: `child exited with status ${String(child.status)} signal ${String(child.signal)}: `
        + `${child.stderr.split('\n').find((line) => line.trim().length > 0)?.slice(0, 160) ?? 'no output'}`,
    };
  }
  try {
    return JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '') as ProbeVerdict;
  } catch {
    return { candidate, status: 'crashed', detail: `unparsable probe output: ${child.stdout.slice(0, 160)}` };
  }
}

/** Probe every candidate. Safe to call from a test: no candidate runs in this process. */
export function probeTypeScriptParser(): readonly ProbeVerdict[] {
  return CANDIDATES.map((candidate) => probeCandidate(candidate));
}

async function main(): Promise<void> {
  const childIndex = argv.indexOf('--child');
  if (childIndex !== -1) {
    const candidate = argv[childIndex + 1] as CandidateName | undefined;
    if (candidate === undefined || !CANDIDATES.includes(candidate)) {
      stdout.write(`${JSON.stringify({ candidate: String(candidate), status: 'absent', detail: 'unknown candidate' })}\n`);
      return;
    }
    try {
      stdout.write(`${JSON.stringify(await runCandidate(candidate))}\n`);
    } catch (cause) {
      stdout.write(`${JSON.stringify({
        candidate, status: 'misbehaved',
        detail: cause instanceof Error ? `${cause.name}: ${cause.message}`.slice(0, 200) : 'unknown failure',
      })}\n`);
    }
    return;
  }

  const typescriptVersion = ((await import('typescript')) as Record<string, unknown>)['version'] ?? 'unknown';
  const verdicts = probeTypeScriptParser();
  if (argv.includes('--json')) {
    stdout.write(`${JSON.stringify({ node: versions.node, typescript: typescriptVersion, verdicts }, null, 2)}\n`);
    return;
  }
  stdout.write(`TypeScript ${String(typescriptVersion)} on Node ${versions.node}\n`);
  for (const verdict of verdicts) {
    stdout.write(`  ${verdict.candidate.padEnd(22)} ${verdict.status.padEnd(11)} ${verdict.detail}\n`);
  }
  const usable = verdicts.filter((verdict) => verdict.status === 'usable');
  stdout.write(usable.length === 0
    ? '\nNo usable syntax-only parser: parser qualification failed.\n'
    : `\n${String(usable.length)} usable candidate(s).\n`);
}

if (argv[1] !== undefined && argv[1].endsWith('probe-typescript-parser.ts')) {
  await main();
}
