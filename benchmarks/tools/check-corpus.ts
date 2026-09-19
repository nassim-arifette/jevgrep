/**
 * Corpus validator for JG-027.
 *
 * It is the executable part of the corpus protocol described in
 * benchmarks/README.md: it recomputes each fixture fingerprint, checks every
 * annotated evidence range against the fixture sources, and refuses to treat a
 * held-out manifest as if its answers were public.
 *
 * Usage:
 *   node benchmarks/tools/check-corpus.ts                 # validate the corpus
 *   node benchmarks/tools/check-corpus.ts --hash <dir>    # print a fixture fingerprint
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type CorpusProblem = {
  readonly file: string;
  readonly message: string;
};

export type CorpusSummary = {
  readonly fixtures: number;
  readonly questions: number;
  readonly behavior: number;
  readonly symbolControls: number;
  readonly noEvidence: number;
  readonly holdoutQuestions: number;
  readonly ambiguous: number;
  readonly alternativeSets: number;
};

const SCHEMA_VERSION = 1;
const SPLITS: readonly string[] = ['development', 'holdout'];
const KINDS: readonly string[] = ['behavior', 'symbol_control', 'no_evidence'];
const ROLES: readonly string[] = ['direct', 'supporting', 'context'];

/** Default corpus root: the benchmarks directory that contains this tool. */
export const defaultCorpusRoot: string = fileURLToPath(new URL('..', import.meta.url));

function listJsonFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function listFixtureDirectories(corpusRoot: string): string[] {
  const fixturesDir = join(corpusRoot, 'fixtures');
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Read a text file with CRLF normalised, so fingerprints are platform independent. */
function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** Number of lines of a text file, using 1-based inclusive line numbering. */
export function countLines(path: string): number {
  const text = readText(path);
  if (text.length === 0) {
    return 0;
  }
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function walkFiles(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...walkFiles(join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      found.push(relativePath);
    }
  }
  return found;
}

/**
 * Fingerprint of a fixture tree: sha256 over the sorted relative paths and the
 * sha256 of each file, with CRLF normalised. Any source edit changes the fingerprint,
 * which forces the annotations to be reviewed again.
 */
export function fixtureTreeHash(fixtureDir: string): string {
  const hash = createHash('sha256');
  for (const relativePath of walkFiles(fixtureDir)) {
    const fileHash = createHash('sha256').update(readText(join(fixtureDir, relativePath))).digest('hex');
    hash.update(`${relativePath}\u0000${fileHash}\n`);
  }
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string, problems: CorpusProblem[]): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) {
      problems.push({ file: path, message: 'the manifest must be a JSON object' });
      return undefined;
    }
    return parsed;
  } catch (error) {
    problems.push({ file: path, message: `unreadable manifest: ${String(error)}` });
    return undefined;
  }
}

function requireString(
  value: unknown,
  label: string,
  file: string,
  problems: CorpusProblem[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push({ file, message: `${label} must be a non-empty string` });
    return undefined;
  }
  return value;
}

type Range = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly role?: string;
};

function readRange(
  value: unknown,
  label: string,
  file: string,
  fixtureDir: string,
  problems: CorpusProblem[],
): Range | undefined {
  if (!isRecord(value)) {
    problems.push({ file, message: `${label} must be an object with path/start_line/end_line` });
    return undefined;
  }
  const path = requireString(value['path'], `${label}.path`, file, problems);
  const startLine = value['start_line'];
  const endLine = value['end_line'];
  const role = value['role'];

  if (path === undefined) {
    return undefined;
  }
  if (path.includes('\\')) {
    problems.push({ file, message: `${label}.path must use forward slashes: ${path}` });
    return undefined;
  }
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || typeof endLine !== 'number' || !Number.isInteger(endLine)) {
    problems.push({ file, message: `${label} must have integer start_line and end_line` });
    return undefined;
  }

  const absolute = resolve(fixtureDir, path);
  const inside = relative(fixtureDir, absolute);
  if (inside.startsWith('..') || inside.startsWith(`..${sep}`) || inside.length === 0) {
    problems.push({ file, message: `${label}.path escapes the fixture directory: ${path}` });
    return undefined;
  }

  let lineCount: number;
  try {
    lineCount = countLines(absolute);
  } catch {
    problems.push({ file, message: `${label}.path does not exist: ${path}` });
    return undefined;
  }

  if (startLine < 1 || endLine < startLine || endLine > lineCount) {
    problems.push({
      file,
      message: `${label} range ${path}:${String(startLine)}-${String(endLine)} is outside the file (${String(lineCount)} lines)`,
    });
    return undefined;
  }
  if (role !== undefined && (typeof role !== 'string' || !ROLES.includes(role))) {
    problems.push({ file, message: `${label}.role must be one of ${ROLES.join(', ')}` });
    return undefined;
  }

  return role === undefined ? { path, startLine, endLine } : { path, startLine, endLine, role };
}

function readRangeList(
  value: unknown,
  label: string,
  file: string,
  fixtureDir: string,
  problems: CorpusProblem[],
): readonly Range[] {
  if (!Array.isArray(value)) {
    problems.push({ file, message: `${label} must be an array of evidence ranges` });
    return [];
  }
  const ranges: Range[] = [];
  for (const [index, item] of value.entries()) {
    const range = readRange(item, `${label}[${String(index)}]`, file, fixtureDir, problems);
    if (range !== undefined) {
      ranges.push(range);
    }
  }
  return ranges;
}

function lineAt(path: string, line: number): string {
  return readText(path).split('\n')[line - 1] ?? '';
}

function checkQuestion(
  value: unknown,
  index: number,
  context: { readonly file: string; readonly fixtureDir: string; readonly fixtureId: string; readonly split: string; readonly holdout: boolean },
  problems: CorpusProblem[],
  counters: { behavior: number; symbolControls: number; noEvidence: number; ambiguous: number; alternativeSets: number },
): number {
  const { file, fixtureDir, fixtureId, split, holdout } = context;
  const label = `questions[${String(index)}]`;
  if (!isRecord(value)) {
    problems.push({ file, message: `${label} must be an object` });
    return 0;
  }

  const id = requireString(value['id'], `${label}.id`, file, problems);
  if (id !== undefined && !id.startsWith(`${fixtureId}.${split}.`)) {
    problems.push({ file, message: `${label}.id must start with '${fixtureId}.${split}.'` });
  }
  requireString(value['question'], `${label}.question`, file, problems);

  const scope = value['scope'];
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((entry) => typeof entry !== 'string')) {
    problems.push({ file, message: `${label}.scope must be a non-empty array of relative paths` });
  }

  const kind = value['kind'];
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    problems.push({ file, message: `${label}.kind must be one of ${KINDS.join(', ')}` });
    return 0;
  }

  if (holdout) {
    for (const forbidden of ['expected_evidence', 'alternative_evidence_sets', 'review_notes']) {
      if (value[forbidden] !== undefined) {
        problems.push({
          file,
          message: `${label}.${forbidden} must not appear in a held-out manifest: reference answers stay outside the agent workspace`,
        });
      }
    }
    return 1;
  }

  const expected = readRangeList(value['expected_evidence'] ?? [], `${label}.expected_evidence`, file, fixtureDir, problems);

  const alternativeSets = value['alternative_evidence_sets'] ?? [];
  if (!Array.isArray(alternativeSets)) {
    problems.push({ file, message: `${label}.alternative_evidence_sets must be an array of sets` });
  } else {
    for (const [setIndex, set] of alternativeSets.entries()) {
      const ranges = readRangeList(set, `${label}.alternative_evidence_sets[${String(setIndex)}]`, file, fixtureDir, problems);
      if (ranges.length === 0) {
        problems.push({ file, message: `${label}.alternative_evidence_sets[${String(setIndex)}] is empty` });
      }
    }
  }

  const ambiguous = value['ambiguous'];
  if (ambiguous !== undefined && typeof ambiguous !== 'boolean') {
    problems.push({ file, message: `${label}.ambiguous must be a boolean` });
  }
  const isAmbiguous = ambiguous === true;
  const reviewNotes = value['review_notes'];
  if (isAmbiguous) {
    counters.ambiguous += 1;
    const hasAlternatives = Array.isArray(alternativeSets) && alternativeSets.length > 0;
    const hasNote = typeof reviewNotes === 'string' && reviewNotes.trim().length > 0;
    if (!hasAlternatives && !hasNote) {
      problems.push({
        file,
        message: `${label} is flagged ambiguous but declares neither alternative evidence nor review notes`,
      });
    }
  }

  if (kind === 'no_evidence') {
    counters.noEvidence += 1;
    if (expected.length > 0) {
      problems.push({ file, message: `${label} is a no-evidence question but declares expected evidence` });
    }
    return 1;
  }

  if (expected.length === 0) {
    problems.push({ file, message: `${label} (${kind}) must declare at least one expected evidence range` });
  }

  if (kind === 'symbol_control') {
    counters.symbolControls += 1;
    const question = typeof value['question'] === 'string' ? value['question'] : '';
    const symbol = /`([^`]+)`/.exec(question)?.[1];
    if (symbol === undefined) {
      problems.push({ file, message: `${label} must quote the exact identifier in backticks, e.g. \`listOrdersForCustomer\`` });
    } else {
      const first = expected[0];
      if (first !== undefined) {
        const absolute = resolve(fixtureDir, first.path);
        const text = readText(absolute)
          .split('\n')
          .slice(first.startLine - 1, first.endLine)
          .join('\n');
        if (!text.includes(symbol)) {
          problems.push({
            file,
            message: `${label} quotes \`${symbol}\` but ${first.path}:${String(first.startLine)}-${String(first.endLine)} does not contain it`,
          });
        }
      }
    }
  } else {
    counters.behavior += 1;
  }

  // A range must point at real content, not at trailing blank lines.
  for (const range of expected) {
    const first = lineAt(resolve(fixtureDir, range.path), range.startLine);
    const last = lineAt(resolve(fixtureDir, range.path), range.endLine);
    if (first.trim().length === 0 || last.trim().length === 0) {
      problems.push({
        file,
        message: `${label} range ${range.path}:${String(range.startLine)}-${String(range.endLine)} starts or ends on a blank line`,
      });
    }
  }

  return 1;
}

function checkManifest(
  manifestPath: string,
  corpusRoot: string,
  problems: CorpusProblem[],
  counters: { behavior: number; symbolControls: number; noEvidence: number; ambiguous: number; alternativeSets: number; holdoutQuestions: number },
): { readonly questions: number; readonly fixtureId: string | undefined } {
  const manifest = readJson(manifestPath, problems);
  if (manifest === undefined) {
    return { questions: 0, fixtureId: undefined };
  }

  if (manifest['schema_version'] !== SCHEMA_VERSION) {
    problems.push({ file: manifestPath, message: `schema_version must be ${String(SCHEMA_VERSION)}` });
  }

  const split = manifest['split'];
  if (typeof split !== 'string' || !SPLITS.includes(split)) {
    problems.push({ file: manifestPath, message: `split must be one of ${SPLITS.join(', ')}` });
    return { questions: 0, fixtureId: undefined };
  }
  const holdout = split === 'holdout';

  const fixture = manifest['fixture'];
  if (!isRecord(fixture)) {
    problems.push({ file: manifestPath, message: 'fixture must be an object' });
    return { questions: 0, fixtureId: undefined };
  }

  const fixtureId = requireString(fixture['id'], 'fixture.id', manifestPath, problems);
  requireString(fixture['title'], 'fixture.title', manifestPath, problems);
  requireString(fixture['license'], 'fixture.license', manifestPath, problems);
  requireString(fixture['authorization'], 'fixture.authorization', manifestPath, problems);

  const fixtureDir = fixtureId === undefined ? undefined : join(corpusRoot, 'fixtures', fixtureId);
  if (fixtureDir !== undefined) {
    const expectedName = `${fixtureId}.${split}.json`;
    if (!manifestPath.endsWith(expectedName)) {
      problems.push({ file: manifestPath, message: `the manifest file must be named ${expectedName}` });
    }
    const revision = fixture['revision'];
    if (!isRecord(revision)) {
      problems.push({ file: manifestPath, message: 'fixture.revision must be an object' });
    } else {
      const kind = requireString(revision['kind'], 'fixture.revision.kind', manifestPath, problems);
      const value = requireString(revision['value'], 'fixture.revision.value', manifestPath, problems);
      if (kind !== 'tree-sha256') {
        problems.push({ file: manifestPath, message: "fixture.revision.kind must be 'tree-sha256'" });
      }
      if (value !== undefined) {
        let actual: string;
        try {
          actual = fixtureTreeHash(fixtureDir);
        } catch {
          problems.push({ file: manifestPath, message: `fixture directory does not exist: fixtures/${fixtureId}` });
          return { questions: 0, fixtureId };
        }
        if (actual !== value) {
          problems.push({
            file: manifestPath,
            message: `fixture.revision.value is stale: recorded ${value.slice(0, 12)}…, current tree ${actual.slice(0, 12)}… — re-review the affected annotations`,
          });
        }
      }
    }
  }

  if (holdout) {
    requireString(manifest['answers_ref'], 'answers_ref', manifestPath, problems);
  }

  const questions = manifest['questions'];
  if (!Array.isArray(questions) || questions.length === 0) {
    problems.push({ file: manifestPath, message: 'questions must be a non-empty array' });
    return { questions: 0, fixtureId };
  }

  const seen = new Set<string>();
  let counted = 0;
  for (const [index, question] of questions.entries()) {
    if (isRecord(question)) {
      const id = question['id'];
      if (typeof id === 'string') {
        if (seen.has(id)) {
          problems.push({ file: manifestPath, message: `duplicate question id '${id}'` });
        }
        seen.add(id);
      }
    }
    const accepted = checkQuestion(
      question,
      index,
      { file: manifestPath, fixtureDir: fixtureDir ?? '', fixtureId: fixtureId ?? '', split, holdout },
      problems,
      counters,
    );
    counted += accepted;
    if (holdout && accepted > 0) {
      counters.holdoutQuestions += 1;
    }
  }

  return { questions: counted, fixtureId };
}

function inspectCorpus(corpusRoot: string): {
  readonly problems: readonly CorpusProblem[];
  readonly notes: readonly string[];
  readonly summary: CorpusSummary;
} {
  const problems: CorpusProblem[] = [];
  const notes: string[] = [];
  const counters = {
    behavior: 0,
    symbolControls: 0,
    noEvidence: 0,
    ambiguous: 0,
    alternativeSets: 0,
    holdoutQuestions: 0,
  };

  let fixtures: string[] = [];
  try {
    fixtures = listFixtureDirectories(corpusRoot);
  } catch {
    problems.push({ file: corpusRoot, message: 'the corpus must contain a fixtures directory' });
  }

  let questions = 0;
  const annotatedFixtures = new Set<string>();

  for (const split of SPLITS) {
    const splitDir = join(corpusRoot, 'manifests', split);
    let files: string[];
    try {
      files = listJsonFiles(splitDir);
    } catch {
      problems.push({ file: splitDir, message: `missing manifests/${split} directory` });
      continue;
    }
    if (split === 'holdout' && files.length === 0) {
      notes.push(
        'manifests/holdout is empty: the held-out question set is part of JG-027 and must be versioned before tuning starts',
      );
    }
    for (const manifestPath of files) {
      const result = checkManifest(manifestPath, corpusRoot, problems, counters);
      questions += result.questions;
      if (result.fixtureId !== undefined) {
        annotatedFixtures.add(result.fixtureId);
      }
    }
  }

  for (const fixture of fixtures) {
    if (!annotatedFixtures.has(fixture)) {
      problems.push({
        file: join(corpusRoot, 'fixtures', fixture),
        message: 'fixture has no manifest in either split',
      });
    }
  }

  const targets = [
    { label: 'behavior questions', current: counters.behavior, target: 30 },
    { label: 'symbol controls', current: counters.symbolControls, target: 10 },
    { label: 'annotated fixtures', current: annotatedFixtures.size, target: 3 },
  ];
  for (const { label, current, target } of targets) {
    if (current < target) {
      notes.push(`${label}: ${String(current)}/${String(target)} (JG-027 is still open)`);
    }
  }

  return {
    problems,
    notes,
    summary: {
      fixtures: fixtures.length,
      questions,
      behavior: counters.behavior,
      symbolControls: counters.symbolControls,
      noEvidence: counters.noEvidence,
      holdoutQuestions: counters.holdoutQuestions,
      ambiguous: counters.ambiguous,
      alternativeSets: counters.alternativeSets,
    },
  };
}

/** Validate the whole corpus and return every problem found. */
export function checkCorpus(corpusRoot: string = defaultCorpusRoot): readonly CorpusProblem[] {
  return inspectCorpus(corpusRoot).problems;
}

/** Count the questions per kind, for progress reporting. */
export function summarizeCorpus(corpusRoot: string = defaultCorpusRoot): CorpusSummary {
  return inspectCorpus(corpusRoot).summary;
}

/** Full report: defects, progress notes towards the JG-027 targets, and counts. */
export function corpusReport(corpusRoot: string = defaultCorpusRoot): {
  readonly problems: readonly CorpusProblem[];
  readonly notes: readonly string[];
  readonly summary: CorpusSummary;
} {
  return inspectCorpus(corpusRoot);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [flag, target] = process.argv.slice(2);
  if (flag === '--hash') {
    if (target === undefined) {
      process.stderr.write('usage: node benchmarks/tools/check-corpus.ts --hash <fixture-directory>\n');
      process.exitCode = 2;
    } else {
      process.stdout.write(`${fixtureTreeHash(resolve(target))}\n`);
    }
  } else {
    const { problems, notes, summary } = corpusReport();
    process.stdout.write(
      `corpus: ${String(summary.fixtures)} fixture(s), ${String(summary.questions)} annotated question(s) ` +
        `(behavior ${String(summary.behavior)}, symbol controls ${String(summary.symbolControls)}, ` +
        `no-evidence ${String(summary.noEvidence)}), ambiguous ${String(summary.ambiguous)}, ` +
        `held-out questions ${String(summary.holdoutQuestions)}\n`,
    );
    for (const note of notes) {
      process.stdout.write(`corpus: note: ${note}\n`);
    }
    if (problems.length > 0) {
      for (const problem of problems) {
        process.stderr.write(`corpus: ${relative(process.cwd(), problem.file)}: ${problem.message}\n`);
      }
      process.stderr.write(`corpus: ${String(problems.length)} problem(s)\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('corpus: no problem found\n');
    }
  }
}
