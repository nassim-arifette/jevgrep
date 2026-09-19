/**
 * Preparation: from an inventory to snapshots and fragments (JG-010, JG-011, JG-012, JG-015).
 *
 * This is the first stage allowed to read bytes, so it is also the stage that applies
 * the content-based exclusions of specification section 5.2: invalid encodings,
 * binary content, empty and whitespace-only files, credential patterns and lines no
 * legal fragment can hold. A credential match quarantines the whole file for this
 * search; the text is never rewritten to "clean" it, because a redacted file would
 * still be a file whose contents left the machine.
 *
 * Preparation is cancellable and reports exactly what it could not finish: an
 * unreadable eligible file or an interrupted walk means the scan can never claim full
 * coverage (requirement R8).
 */
import { countReferenceTokens } from '../response/token-counter.ts';
import { AuthorizedRoot, UnauthorizedPathError } from './authorization.ts';
import { chunkSnapshot } from './chunker.ts';
import type { PreparedFragment, WindowLimits } from './chunker.ts';
import { inventoryScope } from './inventory.ts';
import type { InventoryOptions, InventoryResult } from './inventory.ts';
import { SnapshotError, createSnapshot } from './snapshot.ts';
import type { SourceSnapshot } from './snapshot.ts';

/**
 * Patterns that quarantine a whole file before any dispatch.
 *
 * This reduces accidental disclosure; it cannot prove that arbitrary source text
 * contains no secret. The operator's disclosure authorization still has to cover the
 * eligible code (specification section 5.2).
 */
export const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = Object.freeze([
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'stripe_secret_key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'assigned_secret', pattern: /\b(?:api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i },
]);

/** Name of the first credential pattern found in a text, or null. */
export function findCredentialPattern(text: string): string | null {
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  return null;
}

export type PreparedFile = {
  readonly snapshot: SourceSnapshot;
  readonly fragments: readonly PreparedFragment[];
  readonly strategy: 'syntax' | 'line-window';
  readonly parseFallback: boolean;
};

export type PreparationExclusion = {
  readonly relativePath: string;
  readonly reason: string;
  /** Extra local detail for diagnostics, for example the credential pattern's name. */
  readonly detail?: string;
};

export type PreparedScope = {
  readonly inventory: InventoryResult;
  readonly files: readonly PreparedFile[];
  readonly fragments: readonly PreparedFragment[];
  /** Content-stage exclusions, added to the inventory's own counts. */
  readonly excluded: readonly PreparationExclusion[];
  readonly unreadable: number;
  readonly preparedBytes: number;
  /** False when inventory or preparation stopped early; no full-coverage claim is possible. */
  readonly complete: boolean;
  readonly parseFallbacks: number;
};

export type PreparationLimits = {
  /** Optional aggregate caps; `null` keeps them disabled, which is the default. */
  readonly preparedSourceBytes: number | null;
  readonly candidateFiles: number | null;
  readonly fragments: number | null;
};

export const NO_PREPARATION_LIMITS: PreparationLimits = Object.freeze({
  preparedSourceBytes: null, candidateFiles: null, fragments: null,
});

export type PrepareOptions = {
  readonly inventory: InventoryOptions;
  readonly windowLimits?: WindowLimits;
  readonly limits?: PreparationLimits;
  /** Interrupts preparation between files; the result is then explicitly incomplete. */
  readonly shouldStop?: () => boolean;
};

/**
 * Inventory the scope and prepare every eligible file.
 *
 * The order of the returned fragments is deterministic: normalized path order, then
 * increasing start line, which is also the order a partial scan consumes.
 */
export function prepareScope(
  root: AuthorizedRoot,
  scope: readonly string[],
  options: PrepareOptions,
): PreparedScope {
  const inventory = inventoryScope(root, scope, options.inventory);
  const limits = options.limits ?? NO_PREPARATION_LIMITS;

  const files: PreparedFile[] = [];
  const fragments: PreparedFragment[] = [];
  const excluded: PreparationExclusion[] = [];
  let unreadable = 0;
  let preparedBytes = 0;
  let parseFallbacks = 0;
  let complete = inventory.complete;

  for (const entry of inventory.files) {
    if (options.shouldStop?.() === true) {
      complete = false;
      break;
    }
    if (limits.candidateFiles !== null && files.length >= limits.candidateFiles) {
      complete = false;
      break;
    }

    let bytes;
    try {
      bytes = root.readFileBytes(entry.absolutePath, options.inventory.maxFileBytes);
    } catch (cause) {
      if (cause instanceof UnauthorizedPathError) {
        excluded.push({ relativePath: entry.relativePath, reason: cause.refusal === 'link' ? 'link' : 'not_regular_file' });
        continue;
      }
      unreadable += 1;
      complete = false;
      continue;
    }

    if (limits.preparedSourceBytes !== null && preparedBytes + bytes.length > limits.preparedSourceBytes) {
      complete = false;
      break;
    }

    let snapshot: SourceSnapshot;
    try {
      snapshot = createSnapshot(entry.relativePath, entry.absolutePath, bytes, countReferenceTokens);
    } catch (cause) {
      if (cause instanceof SnapshotError) {
        excluded.push({ relativePath: entry.relativePath, reason: cause.refusal });
        continue;
      }
      throw cause;
    }

    if (snapshot.isBlank()) {
      excluded.push({ relativePath: entry.relativePath, reason: snapshot.byteLength === 0 ? 'empty' : 'whitespace_only' });
      continue;
    }
    const credential = findCredentialPattern(snapshot.text);
    if (credential !== null) {
      excluded.push({ relativePath: entry.relativePath, reason: 'credential_pattern', detail: credential });
      continue;
    }

    const chunked = chunkSnapshot(snapshot, options.windowLimits);
    if (chunked.kind === 'unsupported-long-line') {
      excluded.push({
        relativePath: entry.relativePath, reason: 'unsupported_long_line',
        detail: `line ${String(chunked.line)}`,
      });
      continue;
    }
    if (limits.fragments !== null && fragments.length + chunked.fragments.length > limits.fragments) {
      complete = false;
      break;
    }

    if (chunked.fallback === 'parse_failure') {
      parseFallbacks += 1;
    }
    files.push({
      snapshot, fragments: chunked.fragments, strategy: chunked.strategy,
      parseFallback: chunked.fallback === 'parse_failure',
    });
    fragments.push(...chunked.fragments);
    preparedBytes += bytes.length;
  }

  return {
    inventory, files, fragments, excluded, unreadable, preparedBytes,
    complete: complete && inventory.complete, parseFallbacks,
  };
}

/** Total exclusions by contract reason, combining both stages. */
export function exclusionCounts(prepared: PreparedScope): Record<string, number> {
  const counts: Record<string, number> = { ...prepared.inventory.excludedByReason };
  for (const item of prepared.excluded) {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  }
  return counts;
}
