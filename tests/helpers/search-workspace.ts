/**
 * Temporary repositories and trusted configurations for the engine tests.
 *
 * Every workspace lives outside the project tree, holds its configuration *beside*
 * the repository it authorizes (never inside it) and points the cache at its own
 * directory, so no test can touch a developer's real cache or read a real credential.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createDefaultConfiguration, loadConfiguration } from '../../src/config.ts';
import type { LoadedConfiguration } from '../../src/config.ts';
import type { Configuration } from '../../src/contracts.ts';

export type WorkspaceFiles = Readonly<Record<string, string>>;

export type Workspace = {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly configPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly loaded: LoadedConfiguration;
  write(relativePath: string, content: string): void;
  remove(relativePath: string): void;
  cleanup(): void;
};

export type WorkspaceOptions = {
  readonly files?: WorkspaceFiles;
  /** Applied to the generated configuration before it is written. */
  readonly configure?: (config: Configuration) => Configuration;
  /** Use an existing repository instead of writing files. */
  readonly repositoryRoot?: string;
};

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/** Create a workspace with a repository, a trusted configuration and an isolated cache. */
export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'jevgrep-test-'));
  const repositoryRoot = options.repositoryRoot ?? join(root, 'repository');
  if (options.repositoryRoot === undefined) {
    mkdirSync(repositoryRoot, { recursive: true });
  }

  const write = (relativePath: string, content: string): void => {
    const absolute = join(repositoryRoot, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };
  for (const [path, content] of Object.entries(options.files ?? {})) {
    write(path, content);
  }

  const base = createDefaultConfiguration(toPosix(resolve(repositoryRoot)), 'jev-1.13.0');
  const config = options.configure?.(base) ?? base;
  const configPath = join(root, 'jevgrep.config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const env: NodeJS.ProcessEnv = { JEVGREP_CACHE_HOME: join(root, 'cache') };
  return {
    root,
    repositoryRoot,
    configPath,
    env,
    loaded: loadConfiguration(configPath, { env }),
    write,
    remove(relativePath: string): void {
      rmSync(join(repositoryRoot, relativePath), { force: true });
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A configuration with remote evaluation enabled, as a real search requires. */
export function withRemoteEnabled(config: Configuration): Configuration {
  return { ...config, remote_evaluation_enabled: true };
}
