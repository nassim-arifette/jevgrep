/** Identifier-ish terms, including split camelCase/snake_case parts. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    out.push(word.toLowerCase());
    for (const part of word.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) if (part.length > 1 && part !== word) out.push(part.toLowerCase());
  }
  return out;
}

export const stop = new Set(('the a an and or of to in is it be for on with as by this that at from are was were not but if then else when which what where who how why can could would should will do does did has have had its into than there their them they we you your our i me my he she his her so no yes all any some such only also more most other just one two use used using code existing must change resolve issue does this here these those been being get set').split(' '));

/** Okapi BM25 (k1 = 1.2, b = 0.75) over pre-tokenized documents; returns one score per document. */
export function bm25Scores(documents: readonly (readonly string[])[], query: string): number[] {
  const df = new Map<string, number>();
  for (const doc of documents) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  const avg = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length) || 1;
  const q = [...new Set(terms(query).filter((term) => !stop.has(term)))];
  return documents.map((doc) => {
    const tf = new Map<string, number>();
    for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const idf = Math.log(1 + (documents.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * doc.length / avg));
    }
    return score;
  });
}
