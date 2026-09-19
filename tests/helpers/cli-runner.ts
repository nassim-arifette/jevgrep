import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Repository root, derived from this file's location. */
export const repoRoot: string = fileURLToPath(new URL('../..', import.meta.url));

/** Path to the CLI entry point compiled from src/cli.ts. */
export const sourceEntry: string = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

export type CliResult = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** Absolute URL of the offline preload installed in every spawned CLI process. */
export const offlinePreloadUrl: string = pathToFileURL(
  fileURLToPath(new URL('./offline-preload.ts', import.meta.url)),
).href;

/**
 * Environment without provider credentials, with the offline guard preloaded. The
 * ordinary suite must pass without a Jev key, so tests spawn the CLI with every
 * credential-looking variable removed, and a provider call in the child process fails
 * loudly instead of reaching the network.
 */
export function offlineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(JEV|TYPESAFE|API_KEY|ACCESS_TOKEN)/i.test(key)) {
      delete env[key];
    }
  }
  // Automatic profile discovery must never load the operator's settings/secrets.
  // This fresh path does not need to exist; commands requiring a profile reject it.
  env['JEVGREP_CONFIG_HOME'] = join(tmpdir(), `jevgrep-cli-config-${randomUUID()}`);
  const preload = `--import ${offlinePreloadUrl}`;
  env['NODE_OPTIONS'] = env['NODE_OPTIONS'] === undefined ? preload : `${env['NODE_OPTIONS']} ${preload}`;
  return env;
}

/** Run the CLI entry point in a child process and collect its output and exit code. */
export function runCli(entryPath: string, args: readonly string[], cwd: string = repoRoot): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [entryPath, ...args], {
      cwd,
      env: offlineEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
