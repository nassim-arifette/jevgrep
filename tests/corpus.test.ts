import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkCorpus, corpusReport, defaultCorpusRoot, fixtureTreeHash } from '../benchmarks/tools/check-corpus.ts';

/**
 * JG-027 controls: the corpus annotations must stay valid, and the validator must
 * actually reject broken manifests (a validator that never fails would make the
 * whole corpus check vacuous).
 */
const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTemporaryCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'jevgrep-corpus-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'fixtures', 'tiny', 'src'), { recursive: true });
  mkdirSync(join(root, 'manifests', 'development'), { recursive: true });
  mkdirSync(join(root, 'manifests', 'holdout'), { recursive: true });
  writeFileSync(
    join(root, 'fixtures', 'tiny', 'src', 'sample.ts'),
    'export function alpha(): number {\n  return 1;\n}\n',
    'utf8',
  );
  return root;
}

type Question = Record<string, unknown>;

function manifestFor(root: string, questions: readonly Question[], revision?: string): string {
  const path = join(root, 'manifests', 'development', 'tiny.development.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        schema_version: 1,
        fixture: {
          id: 'tiny',
          title: 'minimal fixture',
          license: 'authored for the test',
          authorization: 'synthetic',
          revision: { kind: 'tree-sha256', value: revision ?? fixtureTreeHash(join(root, 'fixtures', 'tiny')) },
        },
        split: 'development',
        questions,
      },
      null,
      2,
    ),
    'utf8',
  );
  return path;
}

function behaviorQuestion(overrides: Record<string, unknown>): Question {
  return {
    id: 'tiny.development.001',
    kind: 'behavior',
    question: 'Where does alpha return a constant?',
    scope: ['src'],
    expected_evidence: [{ path: 'src/sample.ts', start_line: 1, end_line: 3, role: 'direct' }],
    ambiguous: false,
    review_notes: '',
    ...overrides,
  };
}

test('the repository corpus is valid and reports its progress', () => {
  const problems = checkCorpus(defaultCorpusRoot);
  assert.deepEqual(problems, [], problems.map((problem) => `${problem.file}: ${problem.message}`).join('\n'));

  const report = corpusReport(defaultCorpusRoot);
  // JG-027 targets: at least three fixtures, 30 behavior questions and 10 exact-symbol
  // controls, plus no-evidence questions and at least one recorded ambiguity.
  assert.ok(report.summary.fixtures >= 3, `fixtures: ${String(report.summary.fixtures)}`);
  assert.ok(report.summary.behavior >= 30, `behavior: ${String(report.summary.behavior)}`);
  assert.ok(report.summary.symbolControls >= 10, `symbol controls: ${String(report.summary.symbolControls)}`);
  assert.ok(report.summary.noEvidence >= 2);
  assert.ok(report.summary.ambiguous >= 1);
  assert.ok(report.summary.questions >= 40);

  // Progress must be reported, never silently accepted: an unmet JG-027 target has a
  // note, a met target does not. The held-out split is still missing (specification
  // 11.2 requires a frozen held-out corpus), so it must always be reported while it is.
  const noteFor = (label: string): string | undefined => report.notes.find((note) => note.includes(label));
  assert.equal(noteFor('behavior questions') !== undefined, report.summary.behavior < 30);
  assert.equal(noteFor('symbol controls') !== undefined, report.summary.symbolControls < 10);
  assert.equal(noteFor('annotated fixtures') !== undefined, report.summary.fixtures < 3);
  assert.equal(noteFor('holdout') !== undefined, report.summary.holdoutQuestions === 0);
});

test('a valid manifest produces no problem', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion({})]);
  assert.deepEqual(checkCorpus(root), []);
});

test('a stale fixture fingerprint is rejected', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion({})], 'deadbeef'.repeat(8));
  const problems = checkCorpus(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.message ?? '', /stale/);
});

test('an evidence range outside the file is rejected', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [
    behaviorQuestion({ expected_evidence: [{ path: 'src/sample.ts', start_line: 1, end_line: 99, role: 'direct' }] }),
  ]);
  const problems = checkCorpus(root);
  assert.ok(problems.some((problem) => /outside the file/.test(problem.message)));
});

test('an evidence path that escapes the fixture is rejected', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [
    behaviorQuestion({
      expected_evidence: [{ path: '../../etc/passwd', start_line: 1, end_line: 1, role: 'direct' }],
    }),
  ]);
  const problems = checkCorpus(root);
  assert.ok(problems.some((problem) => /escapes the fixture directory/.test(problem.message)));
});

test('a no-evidence question may not declare evidence', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion({ kind: 'no_evidence' })]);
  const problems = checkCorpus(root);
  assert.ok(problems.some((problem) => /no-evidence question but declares expected evidence/.test(problem.message)));
});

test('a symbol control must really contain the quoted identifier', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [
    behaviorQuestion({
      kind: 'symbol_control',
      question: 'Where is `beta` defined?',
      expected_evidence: [{ path: 'src/sample.ts', start_line: 1, end_line: 3, role: 'direct' }],
    }),
  ]);
  const problems = checkCorpus(root);
  assert.ok(problems.some((problem) => /does not contain it/.test(problem.message)));
});

test('an ambiguous question needs alternative evidence or a review note', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion({ ambiguous: true })]);
  const problems = checkCorpus(root);
  assert.ok(problems.some((problem) => /flagged ambiguous/.test(problem.message)));
});

test('a held-out manifest may not carry reference answers', () => {
  const root = makeTemporaryCorpus();
  writeFileSync(
    join(root, 'manifests', 'holdout', 'tiny.holdout.json'),
    JSON.stringify(
      {
        schema_version: 1,
        fixture: {
          id: 'tiny',
          title: 'minimal fixture',
          license: 'authored for the test',
          authorization: 'synthetic',
          revision: { kind: 'tree-sha256', value: fixtureTreeHash(join(root, 'fixtures', 'tiny')) },
        },
        split: 'holdout',
        answers_ref: 'operator-only:outside-the-checkout/tiny.holdout.answers.json',
        questions: [
          {
            id: 'tiny.holdout.001',
            kind: 'behavior',
            question: 'Where does alpha return a constant?',
            scope: ['src'],
            expected_evidence: [{ path: 'src/sample.ts', start_line: 1, end_line: 3, role: 'direct' }],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  const problems = checkCorpus(root);
  assert.ok(problems.some((problem) => /must not appear in a held-out manifest/.test(problem.message)));
});

test('an unannotated fixture directory is reported', () => {
  const root = makeTemporaryCorpus();
  mkdirSync(join(root, 'fixtures', 'orphan'), { recursive: true });
  writeFileSync(join(root, 'fixtures', 'orphan', 'index.ts'), 'export const orphan = true;\n', 'utf8');
  const problems = checkCorpus(root);
  assert.ok(problems.some((problem) => /has no manifest in either split/.test(problem.message)));
});
