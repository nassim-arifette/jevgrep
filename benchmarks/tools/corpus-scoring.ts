/**
 * Corpus validation and evidence scoring for the retrieval runner (JG-028).
 *
 * The review of the first runner was right: counting overlaps one annotation at a time
 * measures something, but not what JG-027 annotates. The corpus describes *evidence
 * sets* — a coherent group of ranges that together answer a question — and it records
 * alternative sets, ambiguous questions and questions whose correct answer is "no
 * evidence exists". This module scores those three things explicitly and refuses a
 * manifest it cannot interpret, instead of producing a number from a shape it guessed.
 *
 * Scoring rules, all deliberate:
 *
 * - a question is measured against its **best matching set**: the primary
 *   `expected_evidence` or any `alternative_evidence_sets` entry. Alternatives are
 *   different valid answers, so scoring against their union would invent a denominator
 *   nobody claimed;
 * - a set counts as **complete** when every line of every `direct` and `supporting`
 *   annotation is covered. This is annotated range coverage, not semantic correctness.
 *   `context` ranges are background — JG-027 forbids a set made only of them — so they
 *   are counted and reported but never required;
 * - **ambiguous** questions are scored, but kept out of the headline aggregates and
 *   reported in their own block;
 * - a `no_evidence` question is a negative control: the right answer is an empty
 *   selection, so it is excluded from recall and reported as a false positive when
 *   excerpts come back;
 * - precision stays *annotated* precision. An excerpt that overlaps nothing annotated is
 *   not proven useless, and this module never says it is.
 */

/**
 * Roles as JG-027 defines them, checked by `benchmarks/tools/check-corpus.ts`:
 * `direct` answers the question, `supporting` corroborates it, and `context` is
 * background the corpus never allows a set to consist of on its own.
 */
export type EvidenceRole = 'direct' | 'supporting' | 'context';

/** Question kinds of the corpus; `no_evidence` questions are negative controls. */
export type QuestionKind = 'behavior' | 'symbol_control' | 'no_evidence';

export type EvidenceAnnotation = {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly role: EvidenceRole;
  readonly note?: string;
};

export type CorpusQuestion = {
  readonly id: string;
  readonly kind: QuestionKind;
  readonly question: string;
  readonly scope: readonly string[];
  readonly expected_evidence: readonly EvidenceAnnotation[];
  /** Other evidence sets that answer the question just as well. */
  readonly alternative_evidence_sets?: readonly (readonly EvidenceAnnotation[])[];
  readonly ambiguous?: boolean;
  readonly review_notes?: string;
};

export type CorpusManifest = {
  readonly schema_version: number;
  readonly fixture: {
    readonly id: string;
    readonly revision: { readonly kind: string; readonly value: string };
    readonly license?: string;
  };
  readonly split: string;
  readonly budget: { readonly max_context_tokens: number; readonly allow_partial_scan: boolean };
  /** Present when the reference answers live outside the checkout (held-out splits). */
  readonly answers_ref?: unknown;
  readonly questions: readonly CorpusQuestion[];
};

export class CorpusValidationError extends Error {
  override readonly name = 'CorpusValidationError';

  constructor(where: string, detail: string) {
    super(`${where}: ${detail}`);
  }
}

function requireCorpus(condition: boolean, where: string, detail: string): asserts condition {
  if (!condition) {
    throw new CorpusValidationError(where, detail);
  }
}

function validateEvidence(items: unknown, where: string): readonly EvidenceAnnotation[] {
  requireCorpus(Array.isArray(items), where, 'expected an array of evidence items');
  return (items as unknown[]).map((raw, index) => {
    const at = `${where}[${String(index)}]`;
    requireCorpus(typeof raw === 'object' && raw !== null, at, 'expected an evidence object');
    const item = raw as Record<string, unknown>;
    const path = item['path'];
    const start = item['start_line'];
    const end = item['end_line'];
    const role = item['role'];
    requireCorpus(typeof path === 'string' && path.length > 0, at, 'evidence needs a path');
    requireCorpus(!/^([A-Za-z]:|[\\/])/.test(path) && !path.split(/[\\/]/).includes('..'),
      at, `evidence path must be relative and free of traversal: ${path}`);
    requireCorpus(typeof start === 'number' && Number.isInteger(start) && start >= 1, at, 'start_line must be a positive integer');
    requireCorpus(typeof end === 'number' && Number.isInteger(end) && end >= start, at, 'end_line must be an integer at or after start_line');
    requireCorpus(role === 'direct' || role === 'supporting' || role === 'context',
      at, `unknown evidence role: ${String(role)}`);
    return {
      path, start_line: start, end_line: end, role,
      ...(typeof item['note'] === 'string' ? { note: item['note'] } : {}),
    };
  });
}

/**
 * Validate a manifest before anything is executed against it.
 *
 * A corpus the runner cannot interpret is a refusal, never a run with silently skipped
 * questions: a benchmark that quietly drops what it does not understand reports a
 * number about the questions it happened to like.
 */
export function validateManifest(raw: unknown, file: string): CorpusManifest {
  requireCorpus(typeof raw === 'object' && raw !== null, file, 'expected a manifest object');
  const manifest = raw as Record<string, unknown>;
  requireCorpus(manifest['schema_version'] === 1, file, 'unsupported manifest schema version');

  const fixture = manifest['fixture'];
  requireCorpus(typeof fixture === 'object' && fixture !== null, file, 'missing fixture block');
  const fixtureRecord = fixture as Record<string, unknown>;
  const fixtureId = fixtureRecord['id'];
  requireCorpus(typeof fixtureId === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(fixtureId),
    file, 'fixture id must be a simple lowercase identifier');
  const revision = fixtureRecord['revision'];
  requireCorpus(typeof revision === 'object' && revision !== null, file, 'the fixture needs a recorded revision');
  const revisionRecord = revision as Record<string, unknown>;
  requireCorpus(typeof revisionRecord['kind'] === 'string' && typeof revisionRecord['value'] === 'string'
    && (revisionRecord['value'] as string).length > 0, file, 'the fixture revision needs a kind and a value');

  const split = manifest['split'];
  requireCorpus(split === 'development' || split === 'holdout', file, `unknown split: ${String(split)}`);

  const budget = manifest['budget'];
  requireCorpus(typeof budget === 'object' && budget !== null, file, 'missing budget block');
  const budgetRecord = budget as Record<string, unknown>;
  const maxTokens = budgetRecord['max_context_tokens'];
  requireCorpus(typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens >= 1_024,
    file, 'budget.max_context_tokens must be an integer of at least 1024');
  requireCorpus(typeof budgetRecord['allow_partial_scan'] === 'boolean', file, 'budget.allow_partial_scan must be a boolean');

  const questions = manifest['questions'];
  requireCorpus(Array.isArray(questions) && questions.length > 0, file, 'a manifest needs at least one question');

  const seen = new Set<string>();
  const validated = (questions as unknown[]).map((raw, index) => {
    const at = `${file}#questions[${String(index)}]`;
    requireCorpus(typeof raw === 'object' && raw !== null, at, 'expected a question object');
    const question = raw as Record<string, unknown>;
    const id = question['id'];
    requireCorpus(typeof id === 'string' && id.length > 0, at, 'a question needs an id');
    requireCorpus(!seen.has(id), at, `duplicate question id: ${id}`);
    seen.add(id);
    const kind = question['kind'];
    requireCorpus(kind === 'behavior' || kind === 'symbol_control' || kind === 'no_evidence',
      at, `unknown question kind: ${String(kind)}`);
    requireCorpus(typeof question['question'] === 'string' && (question['question'] as string).trim().length > 0,
      at, 'a question needs non-empty text');
    const scope = question['scope'];
    requireCorpus(Array.isArray(scope) && scope.length > 0 && scope.every((entry) => typeof entry === 'string' && entry.length > 0),
      at, 'a question needs a non-empty scope of relative paths');
    for (const entry of scope as string[]) {
      requireCorpus(!/^([A-Za-z]:|[\\/])/.test(entry) && !entry.split(/[\\/]/).includes('..'),
        at, `scope entry must be relative and free of traversal: ${entry}`);
    }

    const alternatives = question['alternative_evidence_sets'];
    const alternativeSets = alternatives === undefined
      ? []
      : (requireCorpus(Array.isArray(alternatives), at, 'alternative_evidence_sets must be an array of sets'),
        (alternatives as unknown[]).map((set, setIndex) => validateEvidence(set, `${at}.alternative_evidence_sets[${String(setIndex)}]`)));

    const ambiguous = question['ambiguous'];
    requireCorpus(ambiguous === undefined || typeof ambiguous === 'boolean', at, 'ambiguous must be a boolean when present');
    const expected = validateEvidence(question['expected_evidence'] ?? [], `${at}.expected_evidence`);
    if (kind === 'no_evidence') {
      requireCorpus(expected.length === 0 && alternativeSets.length === 0, at, 'no-evidence controls cannot declare evidence sets');
    } else {
      for (const set of [expected, ...alternativeSets]) requireCorpus(set.some((item) => item.role !== 'context'), at, 'each evidence set needs direct or supporting evidence');
    }
    const reviewNotes = question['review_notes'];
    requireCorpus(ambiguous !== true || alternativeSets.length > 0 || (typeof reviewNotes === 'string' && reviewNotes.trim().length > 0), at, 'ambiguous questions need alternatives or review notes');

    return {
      id, kind, question: question['question'] as string,
      scope: scope as string[],
      expected_evidence: expected,
      ...(alternativeSets.length === 0 ? {} : { alternative_evidence_sets: alternativeSets }),
      ...(ambiguous === undefined ? {} : { ambiguous }),
      ...(typeof reviewNotes === 'string' ? { review_notes: reviewNotes } : {}),
    } satisfies CorpusQuestion;
  });

  return {
    schema_version: 1,
    fixture: {
      id: fixtureId,
      revision: { kind: revisionRecord['kind'] as string, value: revisionRecord['value'] as string },
      ...(typeof fixtureRecord['license'] === 'string' ? { license: fixtureRecord['license'] } : {}),
    },
    split,
    budget: { max_context_tokens: maxTokens, allow_partial_scan: budgetRecord['allow_partial_scan'] as boolean },
    ...(manifest['answers_ref'] === undefined ? {} : { answers_ref: manifest['answers_ref'] }),
    questions: validated,
  };
}

export type ReturnedRange = { readonly path: string; readonly startLine: number; readonly endLine: number };

export type EvidenceScore = {
  /** How the question is treated: measured, an ambiguity, or a negative control. */
  readonly category: 'scored' | 'ambiguous' | 'no_evidence_control';
  /** Index of the best matching set: 0 is `expected_evidence`, 1+ are the alternatives. */
  readonly best_set: number | null;
  readonly set_count: number;
  readonly evidence_items: number;
  readonly evidence_found: number;
  readonly direct_items: number;
  readonly direct_found: number;
  /** Background ranges: counted, never required for a set to be complete. */
  readonly context_items: number;
  readonly context_found: number;
  /** True when all lines of every direct/supporting annotation in one set are covered. */
  readonly complete_set_found: boolean;
  /** True when every `direct` item of one annotated set was found. */
  readonly direct_set_found: boolean;
  readonly excerpts_returned: number;
  /** Excerpts overlapping an annotation of any set; the numerator of annotated precision. */
  readonly excerpts_overlapping_annotation: number;
};

function overlaps(range: ReturnedRange, item: EvidenceAnnotation): boolean {
  return range.path === item.path && range.startLine <= item.end_line && item.start_line <= range.endLine;
}

function covers(item: EvidenceAnnotation, ranges: readonly ReturnedRange[]): boolean {
  let nextLine = item.start_line;
  for (const range of ranges.filter((range) => overlaps(range, item)).sort((left, right) => left.startLine - right.startLine)) {
    if (range.startLine > nextLine) return false;
    nextLine = Math.max(nextLine, range.endLine + 1);
    if (nextLine > item.end_line) return true;
  }
  return false;
}

type SetScore = {
  found: number;
  directFound: number;
  directItems: number;
  contextFound: number;
  contextItems: number;
  complete: boolean;
  directComplete: boolean;
};

/**
 * Score one annotated set.
 *
 * A set is range-complete when all its `direct` and `supporting` lines are covered. `context`
 * ranges are background — the corpus forbids a set made only of them — so requiring
 * them would make a good answer look incomplete.
 */
function scoreSet(set: readonly EvidenceAnnotation[], ranges: readonly ReturnedRange[]): SetScore {
  const found = set.filter((item) => ranges.some((range) => overlaps(range, item)));
  const required = set.filter((item) => item.role !== 'context');
  const directItems = set.filter((item) => item.role === 'direct');
  const directFound = found.filter((item) => item.role === 'direct');
  const contextItems = set.filter((item) => item.role === 'context');
  const contextFound = found.filter((item) => item.role === 'context');
  return {
    found: found.length,
    directFound: directFound.length,
    directItems: directItems.length,
    contextFound: contextFound.length,
    contextItems: contextItems.length,
    complete: required.length > 0 && required.every((item) => covers(item, ranges)),
    directComplete: directItems.length > 0 && directItems.every((item) => covers(item, ranges)),
  };
}

/** Score one question's returned ranges against its annotated evidence sets. */
export function scoreQuestion(question: CorpusQuestion, ranges: readonly ReturnedRange[]): EvidenceScore {
  const sets: readonly (readonly EvidenceAnnotation[])[] = [
    question.expected_evidence,
    ...(question.alternative_evidence_sets ?? []),
  ].filter((set) => set.length > 0);

  const everyItem = sets.flat();
  const overlapping = ranges.filter((range) => everyItem.some((item) => overlaps(range, item))).length;

  if (question.kind === 'no_evidence') {
    requireCorpus(sets.length === 0, question.id, 'no-evidence controls cannot declare evidence');
    // A no-evidence question is a negative control: the right answer is an empty
    // selection, so returning excerpts is a false positive, not a recall miss.
    return {
      category: 'no_evidence_control', best_set: null, set_count: 0,
      evidence_items: 0, evidence_found: 0, direct_items: 0, direct_found: 0,
      context_items: 0, context_found: 0,
      complete_set_found: ranges.length === 0, direct_set_found: ranges.length === 0,
      excerpts_returned: ranges.length, excerpts_overlapping_annotation: 0,
    };
  }

  requireCorpus(sets.length > 0 && sets.every((set) => set.some((item) => item.role !== 'context')), question.id, 'missing required evidence annotations');

  let bestIndex = 0;
  let best = scoreSet(sets[0] ?? [], ranges);
  for (let index = 1; index < sets.length; index += 1) {
    const candidate = scoreSet(sets[index] ?? [], ranges);
    const better = candidate.complete !== best.complete
      ? candidate.complete
      : candidate.found !== best.found
        ? candidate.found > best.found
        : candidate.directFound > best.directFound;
    if (better) {
      best = candidate;
      bestIndex = index;
    }
  }

  return {
    category: question.ambiguous === true ? 'ambiguous' : 'scored',
    best_set: bestIndex,
    set_count: sets.length,
    evidence_items: sets[bestIndex]?.length ?? 0,
    evidence_found: best.found,
    direct_items: best.directItems,
    direct_found: best.directFound,
    context_items: best.contextItems,
    context_found: best.contextFound,
    complete_set_found: best.complete,
    direct_set_found: best.directComplete,
    excerpts_returned: ranges.length,
    excerpts_overlapping_annotation: overlapping,
  };
}
