import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeReport } from './common.ts';

/**
 * A held-out run must match a manifest frozen before it: the labels, the harness and
 * the product source cannot drift after tuning. A remote model alias is recorded but
 * cannot be pinned from here.
 */
export type Freeze = {
  readonly kind: 'benchmark-freeze';
  readonly createdAt: string;
  readonly split: string;
  readonly datasetHash: string;
  readonly sourceHash: string;
  readonly harnessHash: string;
  readonly packageLockHash: string;
  readonly settingsHash: string;
  readonly model: string;
};

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Identity = Omit<Freeze, 'kind' | 'createdAt'>;

export function writeFreeze(path: string, identity: Identity): string {
  return writeReport(path, { kind: 'benchmark-freeze', createdAt: new Date().toISOString(), ...identity } satisfies Freeze);
}

export function freezeMismatches(frozen: Freeze, current: Identity): string[] {
  if (frozen.kind !== 'benchmark-freeze') return ['not a freeze manifest'];
  return (Object.keys(current) as (keyof Identity)[]).filter((key) => frozen[key] !== current[key]);
}

export function assertFrozen(path: string | undefined, current: Identity): Freeze {
  if (path === undefined) throw new Error('held-out runs require --frozen <manifest> written by --freeze before the run');
  const frozen = JSON.parse(readFileSync(path, 'utf8')) as Freeze;
  const mismatches = freezeMismatches(frozen, current);
  if (mismatches.length > 0) throw new Error(`frozen manifest mismatch: ${mismatches.join(', ')}`);
  return frozen;
}
