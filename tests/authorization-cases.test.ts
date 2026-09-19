import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { after, test } from 'node:test';
import { repoRoot } from './helpers/cli-runner.ts';

/**
 * Fixture lot prepared for JG-008 (path confinement, specification 4.1 and 5.1), which S
 * pilots and M reviews. The junior contribution is the case table plus this check: the table
 * must be complete, machine-checkable and materialisable before S writes the access control
 * against it.
 *
 * This file does not implement authorization. It pins the cases, so the implementation
 * cannot quietly skip a forbidden path form.
 *
 * Conventions: a `scope` target is written the way a caller would pass it, relative to the
 * authorized root; a `layout` target is relative to the directory that contains `authorized`.
 */
type CaseExpectation = 'accept' | 'reject' | 'open';

type PathCase = {
  readonly id: string;
  readonly category: string;
  readonly platform: 'both' | 'windows' | 'posix';
  readonly form: 'scope' | 'layout';
  readonly target?: string;
  readonly expect: CaseExpectation;
  readonly reason?: string;
  readonly question?: string;
  readonly note?: string;
};

type CaseTable = {
  readonly schema_version: number;
  readonly kind: string;
  readonly reference: string;
  readonly reasons: readonly string[];
  readonly required_categories: readonly string[];
  readonly layout: {
    readonly directories: readonly string[];
    readonly files: readonly string[];
    readonly links: readonly { readonly path: string; readonly target: string; readonly kind: string }[];
  };
  readonly cases: readonly PathCase[];
};

const tablePath = join(repoRoot, 'tests', 'fixtures', 'authorization', 'scope-cases.json');
const table = JSON.parse(readFileSync(tablePath, 'utf8')) as CaseTable;
const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Materialise the declared layout so every case points at a real path. */
function materialise(): string {
  const root = mkdtempSync(join(tmpdir(), 'jevgrep-authorization-'));
  temporaryRoots.push(root);
  for (const directory of table.layout.directories) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const file of table.layout.files) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `fixture content for ${file}\n`, 'utf8');
  }
  for (const link of table.layout.links) {
    try {
      symlinkSync(link.target, join(root, link.path), link.kind === 'junction' ? 'junction' : 'file');
    } catch {
      // Creating links needs privileges on Windows; the case stays declared for the
      // platform that can enforce it.
    }
  }
  return root;
}

const authorizedRoot = (root: string): string => resolve(root, 'authorized');

/** Resolve a case target against the root the case is written from. */
function absoluteTarget(root: string, entry: PathCase): string {
  return entry.form === 'scope' ? resolve(authorizedRoot(root), entry.target ?? '') : resolve(root, entry.target ?? '');
}

function inside(path: string, container: string): boolean {
  return path === container || path.startsWith(`${container}${sep}`);
}

test('the case table is well formed', () => {
  assert.equal(table.schema_version, 1);
  assert.equal(table.kind, 'authorization-scope-cases');
  assert.match(table.reference, /jg-008/i);
  assert.ok(table.reasons.length >= 4, 'the documented rejection reasons must be listed');
  assert.ok(table.cases.length >= 20, `expected a broad table, found ${String(table.cases.length)} cases`);

  const ids = new Set<string>();
  for (const entry of table.cases) {
    assert.equal(ids.has(entry.id), false, `duplicate case id ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.ok(['accept', 'reject', 'open'].includes(entry.expect), `${entry.id}: bad expectation`);
    assert.ok(['both', 'windows', 'posix'].includes(entry.platform), `${entry.id}: bad platform`);
    assert.ok(['scope', 'layout'].includes(entry.form), `${entry.id}: bad form`);
    if (entry.expect === 'reject') {
      assert.ok(
        entry.reason !== undefined && table.reasons.includes(entry.reason),
        `${entry.id}: a rejection must name a documented reason`,
      );
    }
    if (entry.expect === 'open') {
      assert.ok(
        entry.question !== undefined && entry.question.trim().length > 0,
        `${entry.id}: an open case must state the question for the owner`,
      );
    }
    if (entry.form === 'layout') {
      assert.ok(entry.target !== undefined, `${entry.id}: a layout case must name its target`);
    }
  }
});

test('every required forbidden form is represented', () => {
  const categories = new Set(table.cases.map((entry) => entry.category));
  for (const required of table.required_categories) {
    assert.ok(categories.has(required), `no case covers the category '${required}'`);
  }
});

test('each non-link layout case lies inside or outside the authorized root as declared', () => {
  const root = materialise();
  const container = authorizedRoot(root);
  for (const entry of table.cases.filter(
    (candidate) => candidate.form === 'layout' && candidate.expect !== 'open' && candidate.reason !== 'link',
  )) {
    const target = absoluteTarget(root, entry);
    const name = `${entry.id} (${entry.target ?? ''})`;
    assert.equal(
      inside(target, container),
      entry.expect === 'accept',
      `${name}: resolution contradicts the declared expectation`,
    );
  }
});

test('a sibling directory with a shared prefix defeats a naive string check', () => {
  // Acceptance criterion 1 of JG-008: a prefix comparison accepts this path, so the case
  // forces canonical containment instead of string matching.
  const root = resolve('/tmp/jevgrep-authorization-probe', 'authorized');
  const sibling = resolve(root, '..', 'authorized-other', 'src', 'app.ts');
  assert.equal(sibling.startsWith(root), true, 'the naive check wrongly accepts it');
  assert.equal(inside(sibling, root), false, 'containment must reject it');
  assert.equal(relative(root, sibling).startsWith('..'), true);

  const declared = table.cases.filter((entry) => entry.category === 'sibling-prefix');
  assert.ok(declared.length >= 2, 'the sibling directory must be covered from a scope and from a resolved target');
  assert.ok(
    declared.some((entry) => (entry.target ?? '').includes('authorized-other')),
    'a case must name the sibling directory itself',
  );
  for (const entry of declared.filter((candidate) => candidate.expect === 'reject')) {
    assert.ok(
      ['outside_root', 'traversal', 'absolute_path'].includes(entry.reason ?? ''),
      `${entry.id}: wrong reason '${entry.reason ?? ''}'`,
    );
  }
});

test('scope entries rejected for their form really carry that form', () => {
  // Two rejection families: a form refused before any resolution (specification 4.1), and a
  // location that resolves outside the root. Each case is checked against its own family.
  const forms: Record<string, (value: string) => boolean> = {
    traversal: (value) => value.split(/[\\/]/).includes('..'),
    absolute_path: (value) => isAbsolute(value) || win32.isAbsolute(value),
    drive_relative: (value) => /^[A-Za-z]:(?![\\/])/.test(value),
    unc_path: (value) => value.startsWith('\\\\') || value.startsWith('//'),
    device_path: (value) => /^(NUL|CON|PRN|AUX|COM[1-9]|LPT[1-9])$/i.test(value) || value.startsWith('\\\\.\\'),
    alternate_data_stream: (value) => /^[A-Za-z0-9_./]+:[^/]*$/.test(value) && !/^[A-Za-z]:[\\/]/.test(value),
    nul_byte: (value) => value.includes('\u0000'),
    invalid_scope_path: () => true,
  };
  for (const [reason, matches] of Object.entries(forms)) {
    const cases = table.cases.filter(
      (entry) => entry.form === 'scope' && entry.expect === 'reject' && entry.reason === reason,
    );
    assert.ok(cases.length > 0, `no rejected scope case for the '${reason}' form`);
    for (const entry of cases) {
      assert.ok(matches(entry.target ?? ''), `${entry.id}: '${entry.target ?? ''}' does not look like ${reason}`);
    }
  }
});

test('the reason taxonomy matches the two rejection families', () => {
  // A form is refused before resolution; a location is refused after canonicalisation.
  // `outside_root` therefore only describes a resolved target (a layout case), never a
  // scope string, which the caller always writes relative to the authorized root.
  for (const entry of table.cases.filter((candidate) => candidate.reason === 'outside_root')) {
    assert.equal(entry.form, 'layout', `${entry.id}: outside_root describes a resolved target`);
  }
  assert.ok(
    table.cases.some((entry) => entry.form === 'scope' && entry.expect === 'reject'),
    'the table must hold at least one refused scope string',
  );
});

test('link cases name a declared link whose target escapes the authorized root', () => {
  const root = materialise();
  const container = authorizedRoot(root);
  const linkCases = table.cases.filter((entry) => entry.expect === 'reject' && entry.reason === 'link');
  assert.ok(linkCases.length >= 2, 'both a symbolic link and a junction must be covered');

  for (const entry of linkCases) {
    const target = entry.target ?? '';
    const absolute = absoluteTarget(root, entry);
    const link = table.layout.links.find((candidate) => {
      const linkPath = resolve(root, candidate.path);
      return target === candidate.path || inside(absolute, linkPath);
    });
    assert.ok(link !== undefined, `${entry.id}: '${target}' must name a declared link or a path through one`);
    const escaping = resolve(dirname(resolve(root, link.path)), link.target);
    assert.equal(inside(escaping, container), false, `${entry.id}: the declared link must escape the root`);
  }
});

test('the fixture material referenced by the table exists in the repository', () => {
  const notes = table.cases.map((entry) => entry.note ?? '').filter((note) => note.includes('tests/fixtures/'));
  assert.ok(notes.length >= 1, 'the table should point at the inert instruction fixture');
  for (const note of notes) {
    const match = /tests\/fixtures\/[A-Za-z0-9._/-]+/.exec(note);
    assert.ok(match !== null, `unreadable reference in note: ${note}`);
    assert.ok(readFileSync(join(repoRoot, match[0]), 'utf8').length > 0, `${match[0]} must exist`);
  }
});
