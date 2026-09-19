import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { checkCorpus, corpusReport, defaultCorpusRoot, fixtureTreeHash } from '../benchmarks/tools/check-corpus.ts';

const temporaryRoots: string[] = [];
after(() => {
  for (const root of temporaryRoots) {
    assert.ok(relative(tmpdir(), root).startsWith('jevgrep-corpus-'));
    rmSync(root, { recursive: true, force: true });
  }
});
function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'jevgrep-corpus-'));
  temporaryRoots.push(root);
  return root;
}
function makeTemporaryCorpus(): string {
  const root = temporaryDirectory();
  mkdirSync(join(root, 'fixtures/tiny/src'), { recursive: true });
  mkdirSync(join(root, 'manifests/development'), { recursive: true });
  mkdirSync(join(root, 'manifests/holdout'), { recursive: true });
  writeFileSync(join(root, 'fixtures/tiny/src/sample.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  return root;
}

type Question = Record<string, unknown>;
const evidence = [{ path: 'src/sample.ts', start_line: 1, end_line: 3, role: 'direct' }];
const answerSetId = 'test-answers';
function manifestFor(root: string, questions: readonly Question[], options: {
  revision?: string; split?: 'development' | 'holdout'; answersRef?: string;
} = {}): string {
  const split = options.split ?? 'development';
  const path = join(root, 'manifests', split, `tiny.${split}.json`);
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    fixture: {
      id: 'tiny', title: 'minimal fixture', license: 'authored for the test', authorization: 'synthetic',
      revision: { kind: 'tree-sha256', value: options.revision ?? fixtureTreeHash(join(root, 'fixtures/tiny')) },
    },
    split,
    ...(split === 'holdout' ? { answers_ref: options.answersRef ?? answerSetId } : {}),
    questions,
  }));
  return path;
}
function behaviorQuestion(overrides: Question = {}): Question {
  return {
    id: 'tiny.development.001', kind: 'behavior', question: 'Where does alpha return a constant?',
    scope: ['src'], expected_evidence: evidence, ambiguous: false, review_notes: '', ...overrides,
  };
}
function holdoutQuestion(overrides: Question = {}): Question {
  return {
    id: 'tiny.holdout.001', kind: 'behavior', question: 'Where does alpha return a constant?', scope: ['src'],
    ...overrides,
  };
}
function operatorAnswers(root: string, overrides: Record<string, unknown> = {}): string {
  const answersFile = join(temporaryDirectory(), 'answers.json');
  writeAnswers(answersFile, root, overrides);
  return answersFile;
}
function writeAnswers(path: string, root: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(path, JSON.stringify({
    schema_version: 1, kind: 'holdout-answers', answer_set_id: answerSetId,
    fixtures: { tiny: {
      revision: { kind: 'tree-sha256', value: fixtureTreeHash(join(root, 'fixtures/tiny')) },
      answers: [{ id: 'tiny.holdout.001', expected_evidence: evidence }], ...overrides,
    } },
  }));
}
function messages(root: string, options: { answersFile?: string; requireAnswers?: boolean } = {}): string {
  return checkCorpus(root, options).map((p) => p.message).join('\n');
}

test('the reviewed corpus meets the frozen development and holdout targets', () => {
  const report = corpusReport();
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.summary, {
    fixtures: 6, questions: 54, behavior: 30, symbolControls: 10, noEvidence: 2,
    holdoutQuestions: 12, ambiguous: 2, alternativeSets: 1,
  });
  assert.ok(report.notes.every((note) => note.startsWith('answer set not available:')));
  assert.equal(report.notes.length, 3);
});
test('a valid development manifest is accepted', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion()]);
  assert.deepEqual(checkCorpus(root), []);
});
test('a stale fingerprint is rejected', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion()], { revision: 'deadbeef'.repeat(8) });
  assert.match(messages(root), /stale/);
});

const invalidQuestions: readonly [string, Question, RegExp][] = [
  ['out-of-range evidence', { expected_evidence: [{ ...evidence[0], end_line: 99 }] }, /outside the file/],
  ['traversal in evidence', { expected_evidence: [{ ...evidence[0], path: '../../secret' }] }, /escapes the fixture/],
  ['missing evidence role', { expected_evidence: [{ path: 'src/sample.ts', start_line: 1, end_line: 3 }] }, /role must be/],
  ['expected evidence outside scope', { scope: ['docs'] }, /outside the requested scope/],
  ['absolute scope', { scope: ['/src'] }, /scope must be/],
  ['traversal scope', { scope: ['src/../docs'] }, /scope must be/],
  ['no-evidence with a reference', { kind: 'no_evidence' }, /no-evidence question but declares/],
  ['no-evidence with an alternative', { kind: 'no_evidence', expected_evidence: [], alternative_evidence_sets: [evidence] }, /no-evidence question but declares/],
  ['unknown symbol', { kind: 'symbol_control', question: 'Where is `beta` defined?' }, /does not contain it/],
  ['unexplained ambiguity', { ambiguous: true }, /flagged ambiguous/],
  ['empty alternative set', { alternative_evidence_sets: [[]] }, /is empty/],
  ['context-only primary set', { expected_evidence: [{ ...evidence[0], role: 'context' }] }, /only of context/],
  ['context-only alternative set', { alternative_evidence_sets: [[{ ...evidence[0], role: 'context' }]] }, /only of context/],
];
for (const [name, overrides, expected] of invalidQuestions) {
  test(name + ' is rejected', () => {
    const root = makeTemporaryCorpus();
    manifestFor(root, [behaviorQuestion(overrides)]);
    assert.match(messages(root), expected);
  });
}
test('alternatives are counted and obey the same scope and content rules', () => {
  const root = makeTemporaryCorpus();
  mkdirSync(join(root, 'fixtures/tiny/docs'));
  writeFileSync(join(root, 'fixtures/tiny/docs/note.md'), 'alpha\n\n');
  manifestFor(root, [behaviorQuestion({
    alternative_evidence_sets: [[{ path: 'docs/note.md', start_line: 1, end_line: 2, role: 'context' }]],
  })]);
  assert.match(messages(root), /outside the requested scope/);
  assert.match(messages(root), /starts or ends on a blank line/);
  assert.equal(corpusReport(root).summary.alternativeSets, 1);
});
test('an orphan fixture is rejected', () => {
  assert.match(messages(makeTemporaryCorpus()), /has no manifest/);
});
test('a linked fixture entry is rejected before its external content is inspected', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion()]);
  const external = temporaryDirectory();
  writeFileSync(join(external, 'private.txt'), 'private fixture sentinel');
  symlinkSync(external, join(root, 'fixtures/tiny/external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(messages(root), '');
  assert.throws(() => fixtureTreeHash(join(root, 'fixtures/tiny')), /must not contain links/);
});
test('a fixture cannot be shared between development and holdout', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion()]);
  manifestFor(root, [holdoutQuestion()], { split: 'holdout' });
  assert.match(messages(root), /disjoint fixtures/);
});
test('the held-out manifests expose only questions and use distinct fixtures', () => {
  const developmentIds = new Set(readdirSync(join(defaultCorpusRoot, 'manifests/development'))
    .filter((name) => name.endsWith('.json')).map((name) => name.split('.')[0]));
  for (const name of readdirSync(join(defaultCorpusRoot, 'manifests/holdout')).filter((name) => name.endsWith('.json'))) {
    const manifest = JSON.parse(readFileSync(join(defaultCorpusRoot, 'manifests/holdout', name), 'utf8')) as {
      fixture: { id: string }; answers_ref: string; questions: Question[];
    };
    assert.equal(developmentIds.has(manifest.fixture.id), false);
    assert.match(manifest.answers_ref, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const question of manifest.questions) {
      assert.deepEqual(Object.keys(question).sort(), ['id', 'kind', 'question', 'scope']);
    }
  }
});
test('public holdout annotations and filesystem answer references are rejected', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [holdoutQuestion({ expected_evidence: evidence })], {
    split: 'holdout', answersRef: join(root, 'implicit-answers.json'),
  });
  assert.match(messages(root), /must not appear in a held-out manifest/);
  assert.match(messages(root), /opaque answer-set identifier/);
});
test('operator answers are opt-in and mandatory for scoring', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [holdoutQuestion()], { split: 'holdout' });
  const answersFile = operatorAnswers(root);
  assert.ok(corpusReport(root).notes.some((n) => n.includes('answer set not available')));
  assert.match(messages(root, { requireAnswers: true }), /answer set not available/);
  assert.match(messages(root, { answersFile: join(tmpdir(), 'does-not-exist.json'), requireAnswers: true }), /answer set not available/);
  const report = corpusReport(root, { answersFile, requireAnswers: true });
  assert.deepEqual(report.problems, []);
  assert.equal(report.notes.some((n) => n.includes('not available')), false);
});
test('answers inside the corpus are rejected, including external aliases', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [holdoutQuestion()], { split: 'holdout' });
  const directory = join(root, 'private');
  mkdirSync(directory);
  const answersFile = join(directory, 'answers.json');
  writeAnswers(answersFile, root);
  assert.match(messages(root, { answersFile }), /outside the checkout\/corpus/);
  const link = join(temporaryDirectory(), 'alias');
  symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(messages(root, { answersFile: join(link, 'answers.json') }), /resolve inside the checkout\/corpus/);
});
test('operator answer-set identity must match the public manifest', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [holdoutQuestion()], { split: 'holdout' });
  const answersFile = operatorAnswers(root);
  const value = JSON.parse(readFileSync(answersFile, 'utf8')) as Record<string, unknown>;
  value['answer_set_id'] = 'another-set';
  writeFileSync(answersFile, JSON.stringify(value));
  assert.match(messages(root, { answersFile }), /identity does not match/);
});

test('a corpus alias cannot disguise an internal answer file as external', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [holdoutQuestion()], { split: 'holdout' });
  const answersFile = join(root, 'internal-answers.json');
  writeAnswers(answersFile, root);
  const alias = join(temporaryDirectory(), 'corpus-alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(messages(alias, { answersFile }), /outside the checkout\/corpus/);
});

test('scoring requires a non-empty held-out split', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [behaviorQuestion()]);
  assert.match(messages(root, { requireAnswers: true }), /holdout is empty/);
});

test('an external corpus still rejects answers located in the curator checkout', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [holdoutQuestion()], { split: 'holdout' });
  const answersFile = join(defaultCorpusRoot, '..', 'operator-answers.json');
  assert.match(messages(root, { answersFile }), /outside the checkout\/corpus/);
});

const invalidAnswers: readonly [string, Record<string, unknown>, RegExp][] = [
  ['stale revision', { revision: { kind: 'tree-sha256', value: '0'.repeat(64) } }, /stale for fixture/],
  ['missing answer', { answers: [] }, /no answer recorded/],
  ['orphan answer', { answers: [{ id: 'tiny.holdout.999', expected_evidence: evidence }] }, /not a question/],
  ['duplicate answer', { answers: [0, 1].map(() => ({ id: 'tiny.holdout.001', expected_evidence: evidence })) }, /duplicate answer/],
  ['invalid range', { answers: [{ id: 'tiny.holdout.001', expected_evidence: [{ ...evidence[0], end_line: 99 }] }] }, /outside the file/],
  ['invalid alternative', { answers: [{ id: 'tiny.holdout.001', expected_evidence: evidence, alternative_evidence_sets: [[{ ...evidence[0], end_line: 99 }]] }] }, /outside the file/],
];
for (const [name, overrides, expected] of invalidAnswers) {
  test('private answers with ' + name + ' are rejected', () => {
    const root = makeTemporaryCorpus();
    manifestFor(root, [holdoutQuestion()], { split: 'holdout' });
    const answersFile = operatorAnswers(root, overrides);
    assert.match(messages(root, { answersFile }), expected);
  });
}
test('private no-evidence answers can be empty but cannot carry alternatives', () => {
  const root = makeTemporaryCorpus();
  manifestFor(root, [holdoutQuestion({ kind: 'no_evidence' })], { split: 'holdout' });
  const answersFile = operatorAnswers(root, { answers: [{ id: 'tiny.holdout.001', expected_evidence: [] }] });
  assert.deepEqual(checkCorpus(root, { answersFile, requireAnswers: true }), []);
  writeAnswers(answersFile, root, { answers: [{
    id: 'tiny.holdout.001', expected_evidence: [], alternative_evidence_sets: [evidence],
  }] });
  assert.match(messages(root, { answersFile }), /no-evidence question but declares/);
});
