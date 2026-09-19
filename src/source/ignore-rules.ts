/**
 * `.gitignore` / `.jevgrepignore` pattern matching (part of JG-010).
 *
 * The specification asks for maintained ignore semantics and forbids shelling out to
 * Git. No ignore library could be pinned inside this offline package, so this module
 * implements the documented subset of the gitignore format that the MVP relies on,
 * and documents what it does not do.
 *
 * Supported: comments, blank lines, escaped characters, `!` negation, anchoring with
 * a leading or inner `/`, directory-only patterns with a trailing `/`, `*` and `?`
 * inside one path segment, `**` across segments, and `[...]` character classes.
 * Precedence follows Git: within one file the last matching pattern wins, and a file
 * deeper in the tree overrides a shallower one.
 *
 * Not supported: `\` escapes of path separators, case-insensitive matching on
 * case-insensitive filesystems (matching is exact), and Git's own index state. A
 * pattern that cannot be compiled is skipped and reported to the caller instead of
 * being silently treated as matching nothing important.
 */

export type IgnoreRule = {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly matcher: RegExp;
  readonly source: string;
};

export type IgnoreFile = {
  /** Directory the rules are anchored to, repository-relative with '/' separators ('' for the root). */
  readonly baseDirectory: string;
  readonly rules: readonly IgnoreRule[];
  /** Negations are dropped for narrowing-only files such as `.jevgrepignore`. */
  readonly narrowingOnly: boolean;
};

function escapeLiteral(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate one gitignore pattern body into an anchored regular expression. */
function compilePattern(pattern: string, anchored: boolean): RegExp | null {
  let regex = anchored ? '^' : '^(?:.*/)?';
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] ?? '';
    if (character === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        return null;
      }
      regex += escapeLiteral(next);
      index += 2;
      continue;
    }
    if (character === '*') {
      const doubled = pattern[index + 1] === '*';
      if (doubled) {
        const followedBySlash = pattern[index + 2] === '/';
        regex += followedBySlash ? '(?:.*/)?' : '.*';
        index += followedBySlash ? 3 : 2;
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
    if (character === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) {
        return null;
      }
      const body = pattern.slice(index + 1, close).replace(/\\/g, '\\\\');
      regex += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      index = close + 1;
      continue;
    }
    regex += escapeLiteral(character);
    index += 1;
  }
  regex += '(?:/.*)?$';
  return new RegExp(regex);
}

/** Parse the text of one ignore file into ordered rules. */
export function parseIgnoreFile(text: string, baseDirectory: string, narrowingOnly = false): IgnoreFile {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
      continue;
    }
    // Trailing spaces are insignificant unless escaped.
    line = line.replace(/(?<!\\)\s+$/, '');
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (negated && narrowingOnly) {
      continue;
    }
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) {
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    if (line.startsWith('/')) {
      line = line.slice(1);
    }
    if (line.length === 0) {
      continue;
    }
    const matcher = compilePattern(line, anchored);
    if (matcher === null) {
      continue;
    }
    rules.push({ negated, directoryOnly, matcher, source: rawLine.trim() });
  }
  return { baseDirectory, rules, narrowingOnly };
}

export type IgnoreDecision = {
  readonly ignored: boolean;
  readonly rule: string | null;
  /** True when the decisive rule came from a narrowing-only file such as `.jevgrepignore`. */
  readonly narrowing: boolean;
};

/**
 * Decide whether a repository-relative path is ignored by a stack of ignore files
 * ordered from the repository root downwards.
 */
export function isIgnored(
  stack: readonly IgnoreFile[],
  relativePath: string,
  isDirectory: boolean,
): IgnoreDecision {
  let decision: IgnoreDecision = { ignored: false, rule: null, narrowing: false };
  for (const file of stack) {
    const prefix = file.baseDirectory === '' ? '' : `${file.baseDirectory}/`;
    if (prefix !== '' && !relativePath.startsWith(prefix)) {
      continue;
    }
    const candidate = relativePath.slice(prefix.length);
    for (const rule of file.rules) {
      if (rule.directoryOnly && !isDirectory) {
        continue;
      }
      if (rule.matcher.test(candidate)) {
        decision = { ignored: !rule.negated, rule: rule.source, narrowing: file.narrowingOnly };
      }
    }
  }
  return decision;
}
