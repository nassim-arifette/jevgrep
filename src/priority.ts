/**
 * Local candidate priority for budgeted scans (roadmap section 10).
 *
 * Lightweight lexical, filename and symbol signals order which candidates a partial
 * scan evaluates first. Nothing is excluded: every candidate keeps a position, and a
 * share of positions is reserved for a path-order sweep of the rest, so candidates
 * whose names or comments do not match the question are still reached. The order
 * never changes a score, the coverage report or the cache identity.
 */

/** Bumped when the ranking signals or the reserve rule change. */
export const PRIORITY_VERSION = 'lexical-priority-1';

export type CandidateOrder =
  | { readonly kind: 'path' }
  | { readonly kind: 'priority'; readonly reserve: number };

export const PATH_ORDER: CandidateOrder = Object.freeze({ kind: 'path' });

const STOP_WORDS = new Set(('the a an and or of to in is it be for on with as by this that at from are was were not but if then '
  + 'else when which what where who how why can could would should will do does did has have had its into than there their them '
  + 'they we you your our i me my so no yes all any some such only also more most other just use used using here these those '
  + 'been being get set').split(' '));

/** Identifier-like terms, lowercased, with camelCase and snake_case parts. */
export function lexicalTerms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const lower = word.toLowerCase();
    out.push(lower);
    for (const part of word.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) {
      const piece = part.toLowerCase();
      if (piece.length > 1 && piece !== lower) out.push(piece);
    }
  }
  return out;
}

function queryTerms(query: string): string[] {
  return [...new Set(lexicalTerms(query).filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

const comparePaths = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Interleave a ranked list with a sweep of the remaining candidates in their original
 * order: `reserve` of the positions (e.g. 0.25 = every fourth) take the next unvisited
 * candidate of `sweep`.
 */
function interleave<T>(ranked: readonly T[], sweep: readonly T[], reserve: number): T[] {
  if (!(reserve > 0)) return [...ranked];
  const taken = new Set<T>();
  const out: T[] = [];
  let r = 0;
  let s = 0;
  for (let slot = 0; out.length < ranked.length; slot += 1) {
    const reserved = Math.floor((slot + 1) * reserve) > Math.floor(slot * reserve);
    const source = reserved ? sweep : ranked;
    let index = reserved ? s : r;
    while (index < source.length && taken.has(source[index]!)) index += 1;
    if (reserved) s = index; else r = index;
    const next = source[index] ?? (reserved ? ranked : sweep).find((item) => !taken.has(item));
    if (next === undefined) break;
    taken.add(next);
    out.push(next);
  }
  return out;
}

type Field = { readonly terms: readonly string[]; readonly weight: number };

/** BM25 over the text field plus idf-weighted matches in name fields; one score per document. */
function lexicalScores(documents: readonly (readonly Field[])[], query: string): number[] {
  const q = queryTerms(query);
  const df = new Map<string, number>();
  for (const fields of documents) {
    for (const term of new Set(fields.flatMap((field) => field.terms))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const n = documents.length;
  const idf = (term: string): number => {
    const count = df.get(term) ?? 0;
    return Math.log(1 + (n - count + 0.5) / (count + 0.5));
  };
  const lengths = documents.map((fields) => fields[0]?.terms.length ?? 0);
  const average = lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, n) || 1;
  return documents.map((fields, index) => {
    let score = 0;
    const [text, ...names] = fields;
    if (text !== undefined && text.terms.length > 0) {
      const tf = new Map<string, number>();
      for (const term of text.terms) tf.set(term, (tf.get(term) ?? 0) + 1);
      for (const term of q) {
        const f = tf.get(term) ?? 0;
        if (f > 0) score += idf(term) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * lengths[index]! / average));
      }
    }
    for (const field of names) {
      const present = new Set(field.terms);
      for (const term of q) if (present.has(term)) score += field.weight * idf(term);
    }
    return score;
  });
}

function pathFields(path: string): Field[] {
  const slash = path.lastIndexOf('/');
  return [
    { terms: lexicalTerms(path.slice(slash + 1)), weight: 2 },
    { terms: lexicalTerms(path.slice(0, Math.max(0, slash))), weight: 0.5 },
  ];
}

function ranked<T>(items: readonly T[], scores: readonly number[], tie: (left: T, right: T) => number): T[] {
  return items.map((item, index) => ({ item, score: scores[index]! }))
    .sort((left, right) => right.score - left.score || tie(left.item, right.item))
    .map((entry) => entry.item);
}

type Orderable = {
  readonly path: string; readonly startLine: number; readonly endLine: number;
  readonly text: string; readonly label?: string | null;
};

const fragmentOrder = (left: Orderable, right: Orderable): number => comparePaths(left.path, right.path)
  || (left.startLine - right.startLine) || (left.endLine - right.endLine);

/** Evaluation order of prepared fragments: lexical, filename and symbol-label signals. */
export function prioritizeFragments<T extends Orderable>(fragments: readonly T[], query: string, order: CandidateOrder): T[] {
  const byPath = [...fragments].sort(fragmentOrder);
  if (order.kind === 'path') return byPath;
  const documents = byPath.map((fragment) => [
    { terms: lexicalTerms(fragment.text), weight: 1 },
    ...pathFields(fragment.path),
    { terms: lexicalTerms(fragment.label ?? ''), weight: 1.5 },
  ]);
  return interleave(ranked(byPath, lexicalScores(documents, query), fragmentOrder), byPath, order.reserve);
}

/** Preparation order of inventoried files from their paths alone (no source is read). */
export function prioritizeFiles<T extends { readonly relativePath: string }>(files: readonly T[], query: string, order: CandidateOrder): T[] {
  if (order.kind === 'path') return [...files];
  const tie = (left: T, right: T): number => comparePaths(left.relativePath, right.relativePath);
  const byPath = [...files].sort(tie);
  const documents = byPath.map((file) => [{ terms: [], weight: 0 }, ...pathFields(file.relativePath)]);
  return interleave(ranked(byPath, lexicalScores(documents, query), tie), byPath, order.reserve);
}

/** Order used by an allowed partial scan unless an experiment overrides it. */
export const PARTIAL_SCAN_ORDER: CandidateOrder = Object.freeze({ kind: 'priority', reserve: 0 });
