/**
 * Deterministic inventory of the eligible scope (JG-010).
 *
 * The inventory answers one question — which files may this search read — and it
 * answers it identically for every question asked about the same working tree. It
 * never looks at the search question, never ranks, and never executes anything from
 * the repository (requirements R1, R3, R11).
 *
 * Exclusion order follows specification section 5.2:
 *   1. authorized root and the requested scope;
 *   2. fixed administrative exclusions (`.git`, credential files, key material);
 *   3. operator deny rules from the trusted configuration;
 *   4. the `.gitignore` hierarchy plus the narrowing `.jevgrepignore`;
 *   5. dependencies, build output, generated or minified artifacts, unsupported
 *      formats and the configured size limit.
 * Content-based exclusions (binary bytes, invalid encoding, credential patterns,
 * empty and whitespace-only files) belong to the preparation stage, which is the
 * first stage that is allowed to read bytes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AuthorizedRoot, UnauthorizedPathError } from './authorization.ts';
import { isIgnored, parseIgnoreFile } from './ignore-rules.ts';
import type { IgnoreFile } from './ignore-rules.ts';

/** Contract exclusion reasons this stage can produce. */
export type InventoryExclusion =
  | 'administrative' | 'credential_file' | 'operator_denied' | 'gitignored' | 'jevgrepignored'
  | 'dependency' | 'build_output' | 'generated' | 'minified' | 'file_too_large'
  | 'unsupported_format' | 'empty' | 'link' | 'outside_root' | 'not_regular_file';

export type InventoryEntry = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
};

export type ExcludedEntry = {
  readonly relativePath: string;
  readonly reason: InventoryExclusion;
  readonly isDirectory: boolean;
};

export type InventoryResult = {
  /** Eligible candidate files, ordered by normalized relative path. */
  readonly files: readonly InventoryEntry[];
  /** Every file entry examined, including the excluded ones. */
  readonly discovered: number;
  readonly excluded: readonly ExcludedEntry[];
  readonly excludedByReason: Readonly<Record<string, number>>;
  /** Directories that were never entered; their descendants stay unknown. */
  readonly excludedDirectories: readonly ExcludedEntry[];
  /** False when any directory could not be listed: the scan cannot claim completeness. */
  readonly complete: boolean;
  readonly traversalErrors: number;
};

export type InventoryOptions = {
  readonly respectGitignore: boolean;
  readonly maxFileBytes: number;
  readonly extraDenyGlobs: readonly string[];
  /** Stops the walk between entries; a cancelled walk is never reported as complete. */
  readonly shouldStop?: () => boolean;
};

/** Directories that are never entered, whatever the scope says. */
const ADMINISTRATIVE_DIRECTORIES = new Set(['.git', '.hg', '.svn', '.jj']);
const CREDENTIAL_DIRECTORIES = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', 'secrets']);
const DEPENDENCY_DIRECTORIES = new Set(['node_modules', 'bower_components', 'vendor', '.pnpm-store', '.yarn']);
const BUILD_DIRECTORIES = new Set(['dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.output']);
const GENERATED_DIRECTORIES = new Set(['generated', '__generated__']);

/** File names that carry credentials or key material and are never transmitted. */
const CREDENTIAL_FILES = new Set([
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', '_netrc', '.pypirc', '.dockercfg',
  'credentials', 'credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const CREDENTIAL_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.asc', '.ppk']);
const GENERATED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb', 'composer.lock']);

/**
 * Extensions the MVP can prepare. Syntax chunking covers the JS/TS family; the rest
 * use bounded line windows. Application configuration is deliberately included:
 * it is frequently the evidence a behaviour question needs.
 */
export const SUPPORTED_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.md', '.sql', '.txt',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function isEnvFamily(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

/** Compile an operator deny glob into a matcher over repository-relative paths. */
function compileDenyGlob(glob: string): RegExp {
  let regex = '^';
  let index = 0;
  while (index < glob.length) {
    const character = glob[index] ?? '';
    if (character === '*') {
      if (glob[index + 1] === '*') {
        const slash = glob[index + 2] === '/';
        regex += slash ? '(?:.*/)?' : '.*';
        index += slash ? 3 : 2;
        continue;
      }
      regex += '[^/]*';
      index += 1;
      continue;
    }
    if (character === '?') {
      regex += '[^/]';
      index += 1;
      continue;
    }
    regex += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }
  return new RegExp(`${regex}(?:/.*)?$`);
}

/** Name-based and size-based eligibility, shared by the walk and by explicit scope files. */
export class EligibilityRules {
  readonly #denyMatchers: readonly RegExp[];
  readonly #maxFileBytes: number;

  constructor(options: InventoryOptions) {
    this.#denyMatchers = options.extraDenyGlobs.map(compileDenyGlob);
    this.#maxFileBytes = options.maxFileBytes;
  }

  /** Reason a directory must not be entered, or null when it may be. */
  directoryExclusion(name: string, relativePath: string): InventoryExclusion | null {
    if (ADMINISTRATIVE_DIRECTORIES.has(name)) {
      return 'administrative';
    }
    if (CREDENTIAL_DIRECTORIES.has(name)) {
      return 'credential_file';
    }
    // `src/private` and `src/private/**` both deny the directory, so it is pruned
    // rather than walked: its descendants then stay explicitly unknown.
    if (this.#denyMatchers.some((matcher) => matcher.test(relativePath) || matcher.test(`${relativePath}/`))) {
      return 'operator_denied';
    }
    if (DEPENDENCY_DIRECTORIES.has(name)) {
      return 'dependency';
    }
    if (BUILD_DIRECTORIES.has(name)) {
      return 'build_output';
    }
    if (GENERATED_DIRECTORIES.has(name)) {
      return 'generated';
    }
    return null;
  }

  /** Reason a file is not a candidate, or null when it is. */
  fileExclusion(name: string, relativePath: string, sizeBytes: number): InventoryExclusion | null {
    if (isEnvFamily(name) || CREDENTIAL_FILES.has(name) || CREDENTIAL_EXTENSIONS.has(extensionOf(name))) {
      return 'credential_file';
    }
    if (this.#denyMatchers.some((matcher) => matcher.test(relativePath))) {
      return 'operator_denied';
    }
    if (GENERATED_FILES.has(name)) {
      return 'generated';
    }
    if (/\.min\.(js|mjs|cjs|css)$/i.test(name) || /\.bundle\.js$/i.test(name)) {
      return 'minified';
    }
    if (/\.(generated|gen)\.[A-Za-z0-9]+$/i.test(name) || /\.d\.ts$/i.test(name)) {
      return 'generated';
    }
    if (!SUPPORTED_EXTENSIONS.has(extensionOf(name))) {
      return 'unsupported_format';
    }
    if (sizeBytes === 0) {
      return 'empty';
    }
    if (sizeBytes > this.#maxFileBytes) {
      return 'file_too_large';
    }
    return null;
  }
}

type Accumulator = {
  readonly files: InventoryEntry[];
  readonly excluded: ExcludedEntry[];
  readonly excludedDirectories: ExcludedEntry[];
  readonly seen: Set<string>;
  discovered: number;
  traversalErrors: number;
  complete: boolean;
};

/** A missing or unreadable ignore file narrows nothing; the walk continues. */
function readIgnoreFile(
  absoluteDirectory: string,
  relativeDirectory: string,
  fileName: string,
  narrowingOnly: boolean,
): IgnoreFile | null {
  try {
    const text = readFileSync(join(absoluteDirectory, fileName), 'utf8');
    return parseIgnoreFile(text, relativeDirectory, narrowingOnly);
  } catch {
    return null;
  }
}

function joinRelative(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

/**
 * Inventory one authorized scope.
 *
 * Ordering is by normalized relative path so that two runs over the same working
 * tree produce the same list, and overlapping scope entries contribute one entry.
 */
export function inventoryScope(
  root: AuthorizedRoot,
  scope: readonly string[],
  options: InventoryOptions,
): InventoryResult {
  const rules = new EligibilityRules(options);
  const accumulator: Accumulator = {
    files: [], excluded: [], excludedDirectories: [], seen: new Set<string>(),
    discovered: 0, traversalErrors: 0, complete: true,
  };

  for (const entry of scope) {
    if (options.shouldStop?.() === true) {
      accumulator.complete = false;
      break;
    }
    let resolved;
    try {
      resolved = root.resolveEntry(entry);
    } catch (cause) {
      if (cause instanceof UnauthorizedPathError) {
        const reason: InventoryExclusion = cause.refusal === 'link' ? 'link'
          : cause.refusal === 'outside_root' ? 'outside_root' : 'not_regular_file';
        accumulator.excluded.push({ relativePath: entry, reason, isDirectory: false });
        accumulator.discovered += 1;
        if (cause.refusal === 'missing') {
          accumulator.complete = false;
        }
        continue;
      }
      throw cause;
    }

    if (resolved.kind === 'file') {
      const name = resolved.relativePath.slice(resolved.relativePath.lastIndexOf('/') + 1);
      const parent = resolved.relativePath.includes('/')
        ? resolved.relativePath.slice(0, resolved.relativePath.lastIndexOf('/')) : '';
      const stack = ignoreStackFor(root, parent, options);
      considerFile(root, accumulator, rules, stack, {
        name, relativePath: resolved.relativePath, absolutePath: resolved.absolutePath, sizeBytes: resolved.sizeBytes,
      });
      continue;
    }

    const relativeDirectory = resolved.relativePath === '.' ? '' : resolved.relativePath;
    walkDirectory(root, accumulator, rules, ignoreStackFor(root, relativeDirectory, options), options,
      resolved.absolutePath, relativeDirectory);
  }

  accumulator.files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  accumulator.excluded.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));

  const excludedByReason: Record<string, number> = {};
  for (const item of accumulator.excluded) {
    excludedByReason[item.reason] = (excludedByReason[item.reason] ?? 0) + 1;
  }

  return {
    files: accumulator.files,
    discovered: accumulator.discovered,
    excluded: accumulator.excluded,
    excludedByReason,
    excludedDirectories: accumulator.excludedDirectories,
    complete: accumulator.complete,
    traversalErrors: accumulator.traversalErrors,
  };
}

/** Ignore files from the root down to a directory, in Git's precedence order. */
function ignoreStackFor(root: AuthorizedRoot, relativeDirectory: string, options: InventoryOptions): IgnoreFile[] {
  const stack: IgnoreFile[] = [];
  const segments = relativeDirectory === '' ? [] : relativeDirectory.split('/');
  let absolute = root.path;
  let relative = '';
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) {
      const segment = segments[index - 1] ?? '';
      absolute = join(absolute, segment);
      relative = joinRelative(relative, segment);
    }
    stack.push(...directoryIgnoreFiles(absolute, relative, options));
  }
  return stack;
}

function directoryIgnoreFiles(
  absoluteDirectory: string,
  relativeDirectory: string,
  options: InventoryOptions,
): IgnoreFile[] {
  const found: IgnoreFile[] = [];
  if (options.respectGitignore) {
    const gitignore = readIgnoreFile(absoluteDirectory, relativeDirectory, '.gitignore', false);
    if (gitignore !== null) {
      found.push(gitignore);
    }
  }
  const jevgrepignore = readIgnoreFile(absoluteDirectory, relativeDirectory, '.jevgrepignore', true);
  if (jevgrepignore !== null) {
    found.push(jevgrepignore);
  }
  return found;
}

function considerFile(
  root: AuthorizedRoot,
  accumulator: Accumulator,
  rules: EligibilityRules,
  stack: readonly IgnoreFile[],
  file: { name: string; relativePath: string; absolutePath: string; sizeBytes: number },
): void {
  const identity = root.identityKey(file.absolutePath);
  if (accumulator.seen.has(identity)) {
    return;
  }
  accumulator.seen.add(identity);
  accumulator.discovered += 1;

  const named = rules.fileExclusion(file.name, file.relativePath, file.sizeBytes);
  if (named !== null) {
    accumulator.excluded.push({ relativePath: file.relativePath, reason: named, isDirectory: false });
    return;
  }
  const ignored = isIgnored(stack, file.relativePath, false);
  if (ignored.ignored) {
    accumulator.excluded.push({
      relativePath: file.relativePath,
      reason: ignored.narrowing ? 'jevgrepignored' : 'gitignored',
      isDirectory: false,
    });
    return;
  }
  accumulator.files.push({
    relativePath: file.relativePath, absolutePath: file.absolutePath, sizeBytes: file.sizeBytes,
  });
}

function walkDirectory(
  root: AuthorizedRoot,
  accumulator: Accumulator,
  rules: EligibilityRules,
  inheritedStack: readonly IgnoreFile[],
  options: InventoryOptions,
  absoluteDirectory: string,
  relativeDirectory: string,
): void {
  if (options.shouldStop?.() === true) {
    accumulator.complete = false;
    return;
  }

  let entries;
  try {
    entries = readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch {
    accumulator.traversalErrors += 1;
    accumulator.complete = false;
    return;
  }

  const stack = relativeDirectory === ''
    ? inheritedStack
    : [...inheritedStack, ...directoryIgnoreFiles(absoluteDirectory, relativeDirectory, options)];

  // Deterministic order: the walk does not depend on the filesystem's listing order.
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  for (const entry of entries) {
    if (options.shouldStop?.() === true) {
      accumulator.complete = false;
      return;
    }
    const relativePath = joinRelative(relativeDirectory, entry.name);
    const absolutePath = join(absoluteDirectory, entry.name);

    if (entry.isSymbolicLink()) {
      const record = { relativePath, reason: 'link' as const, isDirectory: false };
      accumulator.discovered += 1;
      accumulator.excluded.push(record);
      continue;
    }
    if (entry.isDirectory()) {
      const excluded = rules.directoryExclusion(entry.name, relativePath);
      if (excluded !== null) {
        accumulator.excludedDirectories.push({ relativePath, reason: excluded, isDirectory: true });
        continue;
      }
      const ignoredDirectory = isIgnored(stack, relativePath, true);
      if (ignoredDirectory.ignored) {
        accumulator.excludedDirectories.push({
          relativePath, reason: ignoredDirectory.narrowing ? 'jevgrepignored' : 'gitignored', isDirectory: true,
        });
        continue;
      }
      walkDirectory(root, accumulator, rules, stack, options, absolutePath, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      accumulator.discovered += 1;
      accumulator.excluded.push({ relativePath, reason: 'not_regular_file', isDirectory: false });
      continue;
    }

    let sizeBytes = 0;
    try {
      sizeBytes = root.resolveEntry(relativePath).sizeBytes;
    } catch (cause) {
      accumulator.discovered += 1;
      const reason: InventoryExclusion = cause instanceof UnauthorizedPathError && cause.refusal === 'link'
        ? 'link' : 'not_regular_file';
      accumulator.excluded.push({ relativePath, reason, isDirectory: false });
      continue;
    }
    considerFile(root, accumulator, rules, stack, {
      name: entry.name, relativePath, absolutePath, sizeBytes,
    });
  }
}
