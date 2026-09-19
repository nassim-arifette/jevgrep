import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { repoRoot as rawRepoRoot } from './helpers/cli-runner.ts';

/** `fileURLToPath` keeps a trailing separator; normalise it before comparing paths. */
const repoRoot = resolve(rawRepoRoot);

function isInsideRepository(path: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
  return absolute === repoRoot || absolute.startsWith(`${repoRoot}${sep}`);
}

/**
 * Fixture lot prepared for JG-004 (the live provider contract probe), which S pilots and M
 * reviews: "J organise les cas et les observations expurgées".
 *
 * The table is the checklist, not the evidence. It must be complete against the probe work
 * of the issue, machine-checkable, and hygiene-safe: it may name the credential variable but
 * never a credential, and it must separate sanitized artifacts (shareable) from raw captures
 * (kept outside the checkout).
 */
type ProbeCase = {
  readonly id: string;
  readonly area: string;
  readonly question: string;
  readonly observation: string;
  readonly record: readonly string[];
  readonly live: boolean;
  readonly blocking: boolean;
  readonly status: 'open' | 'answered';
  readonly answer_ref?: string;
};

type ProbeTable = {
  readonly schema_version: number;
  readonly kind: string;
  readonly reference: string;
  readonly credential_env_var: string;
  readonly sanitized_evidence_dir: string;
  readonly raw_capture_dir: string;
  readonly redaction_rules: readonly string[];
  readonly required_areas: readonly string[];
  readonly cases: readonly ProbeCase[];
};

const tablePath = join(repoRoot, 'tests', 'fixtures', 'provider-contract', 'probe-cases.json');
const table = JSON.parse(readFileSync(tablePath, 'utf8')) as ProbeTable;
const specification = readFileSync(join(repoRoot, 'docs', 'specification.md'), 'utf8');

test('the probe table is well formed', () => {
  assert.equal(table.schema_version, 1);
  assert.equal(table.kind, 'provider-probe-cases');
  assert.match(table.reference, /jg-004/i);
  assert.ok(table.cases.length >= 12, `expected a broad checklist, found ${String(table.cases.length)}`);
  assert.ok(table.redaction_rules.length >= 3, 'the redaction rules must be stated');

  const ids = new Set<string>();
  for (const entry of table.cases) {
    assert.equal(ids.has(entry.id), false, `duplicate case id ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.ok(entry.question.trim().length > 0, `${entry.id}: no question`);
    assert.ok(entry.observation.trim().length > 0, `${entry.id}: no observation protocol`);
    assert.ok(entry.record.length > 0, `${entry.id}: nothing is recorded, so the answer cannot be reviewed`);
    assert.ok(['open', 'answered'].includes(entry.status), `${entry.id}: bad status`);
    if (entry.status === 'answered') {
      assert.ok(
        entry.answer_ref !== undefined && entry.answer_ref.trim().length > 0,
        `${entry.id}: an answered case must point at its sanitized evidence`,
      );
    }
    if (entry.live) {
      assert.equal(typeof entry.blocking, 'boolean');
    }
  }
});

test('every area the issue must settle is covered', () => {
  const areas = new Set(table.cases.map((entry) => entry.area));
  for (const required of table.required_areas) {
    assert.ok(areas.has(required), `no case covers the area '${required}'`);
  }
});

test('the credential is named by variable only and never embedded', () => {
  // The configuration example of the specification uses the same variable name, so the probe
  // cannot silently invent a second one.
  assert.match(specification, new RegExp(table.credential_env_var));
  assert.match(table.credential_env_var, /^[A-Z][A-Z0-9_]*$/);

  const raw = readFileSync(tablePath, 'utf8');
  assert.doesNotMatch(raw, /\bsk-[A-Za-z0-9]{8,}/, 'a literal-looking key must not appear in the table');
  assert.doesNotMatch(raw, /\b[A-Fa-f0-9]{32,}\b/, 'a long hex literal must not appear in the table');
  assert.doesNotMatch(raw, /\beyJ[A-Za-z0-9_-]{10,}/, 'a JWT-looking literal must not appear in the table');
  assert.doesNotMatch(raw, /Bearer\s+[A-Za-z0-9._-]{10,}/i, 'a bearer literal must not appear in the table');
});

test('sanitized evidence stays in the repository, raw captures stay outside', () => {
  // The helper itself is checked first: a containment test that cannot answer "inside"
  // would let a raw capture directory inside the checkout pass unnoticed.
  assert.equal(isInsideRepository('docs/specification.md'), true, 'the helper must detect an inside path');
  assert.equal(isInsideRepository('..'), false, 'the helper must detect an outside path');
  assert.equal(isInsideRepository(table.sanitized_evidence_dir), true, 'sanitized evidence belongs to the repository');
  assert.equal(isInsideRepository(table.raw_capture_dir), false, 'unexpurgated captures stay outside the checkout');
  assert.ok(table.redaction_rules.some((rule) => /key|token|credential/i.test(rule)));
});

test('the blocking cases match the evidence the issue says is still missing', () => {
  const blocking = table.cases.filter((entry) => entry.blocking);
  const blockingIds = blocking.map((entry) => entry.id);
  assert.ok(blockingIds.length >= 5, 'the probe must declare its blocking cases');
  const areas = new Set(blocking.map((entry) => entry.area));
  for (const area of ['authentication', 'correlation', 'model-identity', 'usage', 'cancellation']) {
    assert.ok(areas.has(area), `the blocking set must include '${area}'`);
  }
  for (const entry of blocking) {
    assert.equal(entry.live, true, `${entry.id} is blocking but claims not to need the provider`);
  }
});
