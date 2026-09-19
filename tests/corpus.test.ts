import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { checkCorpus, corpusReport, defaultCorpusRoot, fixtureTreeHash } from '../benchmarks/tools/check-corpus.ts';
import { repoRoot as rawRepoRoot } from './helpers/cli-runner.ts';

/** `fileURLToPath` keeps a trailing separator; normalise it before comparing paths. */
const repoRoot = resolve(rawRepoRoot);

function isInsideRepository(path: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
  return absolute === repoRoot || absolute.startsWith(`${repoRoot}${sep}`);
}

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

test('the held-out split is versioned, distinct from development and answer-free', () => {
  const holdoutDir = join(defaultCorpusRoot, 'manifests', 'holdout');
  const developmentDir = join(defaultCorpusRoot, 'manifests', 'development');
  const heldOutFiles = readdirSync(holdoutDir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  // Specification 11.2: a versioned development corpus AND a held-out corpus.
  assert.ok(heldOutFiles.length >= 3, `held-out manifests: ${String(heldOutFiles.length)}`);

  const developmentQuestions = new Set<string>();
  for (const name of readdirSync(developmentDir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(developmentDir, name), 'utf8')) as {
      questions: readonly { question: string }[];
    };
    for (const question of manifest.questions) {
      developmentQuestions.add(question.question.trim().toLowerCase());
    }
  }
  assert.ok(developmentQuestions.size >= 30);

  for (const name of heldOutFiles) {
    const manifest = JSON.parse(readFileSync(join(holdoutDir, name), 'utf8')) as {
      split: string;
      answers_ref: string;
      fixture: { id: string; revision: { value: string } };
      questions: readonly { id: string; question: string; kind: string }[];
    };
    const fixtureId = manifest.fixture.id;

    assert.equal(name, `${fixtureId}.holdout.json`);
    assert.equal(manifest.split, 'holdout');
    assert.ok(manifest.questions.length >= 3, `${name}: at least three held-out questions`);
    assert.equal(
      manifest.questions.some((question) => question.kind === 'symbol_control'),
      true,
      `${name}: the held-out split keeps exact-symbol controls`,
    );

    const developmentManifest = JSON.parse(
      readFileSync(join(developmentDir, `${fixtureId}.development.json`), 'utf8'),
    ) as { fixture: { revision: { value: string } } };
    assert.equal(
      manifest.fixture.revision.value,
      developmentManifest.fixture.revision.value,
      `${name}: the held-out questions must target the frozen fixture revision`,
    );

    for (const question of manifest.questions) {
      assert.equal(
        developmentQuestions.has(question.question.trim().toLowerCase()),
        false,
        `held-out question repeated from development: ${question.question}`,
      );
    }

    // Acceptance criterion 5: reference answers are not in the agent's workspace. The
    // containment helper is asserted both ways, because `repoRoot` keeps a trailing
    // separator and a naive `startsWith(root + sep)` comparison could never fail.
    assert.equal(typeof manifest.answers_ref, 'string');
    assert.ok(manifest.answers_ref.trim().length > 0, `${name}: answers_ref is required`);
    assert.equal(isInsideRepository('docs/specification.md'), true, 'the helper must detect an inside path');
    assert.equal(
      isInsideRepository(manifest.answers_ref),
      false,
      `${name}: the answer file must live outside the checkout`,
    );
  }

  const report = corpusReport(defaultCorpusRoot);
  assert.ok(report.summary.holdoutQuestions >= 10, `held-out questions: ${String(report.summary.holdoutQuestions)}`);
  assert.equal(
    report.notes.some((note) => note.includes('holdout')),
    false,
    'a versioned held-out split removes the "holdout is empty" note',
  );
});

test('the report says whether the operator-side answers were available', () => {
  // The report must match reality: a missing answers file is a note, an available one is
  // validated. This keeps CI (no answers on disk) and a release run (answers present)
  // honest without pretending either one is the other.
  const holdoutDir = join(defaultCorpusRoot, 'manifests', 'holdout');
  const report = corpusReport(defaultCorpusRoot);

  for (const name of readdirSync(holdoutDir).filter((entry) => entry.endsWith('.json'))) {
    const manifest = JSON.parse(readFileSync(join(holdoutDir, name), 'utf8')) as { answers_ref: string };
    const referenced = resolve(manifest.answers_ref);
    const unavailable = report.notes.some((note) => note.includes(`answer file not available: ${manifest.answers_ref}`));
    assert.equal(
      unavailable,
      !existsSync(referenced),
      `${name}: the note about ${manifest.answers_ref} must match whether that file exists`,
    );
  }
});

test('a broken held-out answer file is rejected, a correct one is accepted', () => {
  const root = makeTemporaryCorpus();
  const answersPath = join(root, 'operator-answers.json');
  const revision = fixtureTreeHash(join(root, 'fixtures', 'tiny'));
  const question = {
    id: 'tiny.holdout.001',
    kind: 'behavior',
    question: 'Where does alpha return a constant?',
    scope: ['src'],
  };
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
          revision: { kind: 'tree-sha256', value: revision },
        },
        split: 'holdout',
        answers_ref: answersPath,
        questions: [question],
      },
      null,
      2,
    ),
    'utf8',
  );

  const writeAnswers = (value: unknown): void => {
    writeFileSync(answersPath, JSON.stringify(value, null, 2), 'utf8');
  };
  const defaultAnswers = [
    {
      id: 'tiny.holdout.001',
      expected_evidence: [{ path: 'src/sample.ts', start_line: 1, end_line: 3, role: 'direct' }],
    },
  ];
  const answersFor = (
    recordedRevision: string,
    answers: readonly unknown[],
  ): Record<string, unknown> => ({
    schema_version: 1,
    kind: 'holdout-answers',
    fixtures: { tiny: { revision: { kind: 'tree-sha256', value: recordedRevision }, answers } },
  });

  // Correct answers: accepted, and the file is not reported as missing.
  writeAnswers(answersFor(revision, defaultAnswers));
  let report = corpusReport(root);
  assert.deepEqual(report.problems, [], report.problems.map((problem) => problem.message).join('\n'));
  assert.deepEqual(report.notes.filter((note) => note.includes('not available')), []);

  // Stale fingerprint: rejected.
  writeAnswers(answersFor('deadbeef'.repeat(8), defaultAnswers));
  report = corpusReport(root);
  assert.ok(report.problems.some((problem) => /stale for fixture tiny/.test(problem.message)));

  // Answer for a question the manifest does not contain: rejected.
  writeAnswers(answersFor(revision, [{ id: 'tiny.holdout.999', expected_evidence: [] }]));
  report = corpusReport(root);
  assert.ok(report.problems.some((problem) => /is not a question of the held-out manifest/.test(problem.message)));

  // A held-out question without any answer: rejected.
  writeAnswers(answersFor(revision, []));
  report = corpusReport(root);
  assert.ok(report.problems.some((problem) => /no answer recorded for held-out question/.test(problem.message)));

  // Out-of-range evidence in an answer: rejected.
  writeAnswers(
    answersFor(revision, [
      { id: 'tiny.holdout.001', expected_evidence: [{ path: 'src/sample.ts', start_line: 1, end_line: 99, role: 'direct' }] },
    ]),
  );
  report = corpusReport(root);
  assert.ok(report.problems.some((problem) => /outside the file/.test(problem.message)));
});
