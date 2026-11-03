/**
 * False-premise questions for experiment E8 (roadmap section 14).
 *
 * Each question assumes a behavior the pinned source contradicts. The required units
 * are the code, configuration or test that refutes the premise: useful counterevidence,
 * distinct from true negatives where the source holds nothing relevant.
 */
import type { Evidence } from './dataset.ts';
import { fixtureHashes } from './dataset.ts';

export const falsePremiseVersion = 'false-premise-1';

export type FalsePremiseSource =
  | { readonly kind: 'synthetic'; readonly repository: keyof typeof fixtureHashes }
  | { readonly kind: 'real'; readonly task: string };

export type FalsePremiseQuestion = {
  readonly id: string;
  readonly split: 'tuning' | 'heldout';
  readonly source: FalsePremiseSource;
  readonly query: string;
  /** Required counterevidence units. */
  readonly evidence: readonly Evidence[];
  /** Useful but not required. */
  readonly complementary: readonly Evidence[];
};

const range = (path: string, startLine: number, endLine: number): Evidence => ({ path, startLine, endLine });
const synthetic = (repository: keyof typeof fixtureHashes): FalsePremiseSource => ({ kind: 'synthetic', repository });
const requests: FalsePremiseSource = { kind: 'real', task: 'psf__requests-2617' };
const flask: FalsePremiseSource = { kind: 'real', task: 'pallets__flask-4992' };

export const falsePremiseQuestions: readonly FalsePremiseQuestion[] = [
  { id: 'fp-subscription-01', split: 'tuning', source: synthetic('subscription-cache'),
    query: 'Why does a subscription change leave stale cached user data in place?',
    evidence: [range('src/handler.ts', 4, 9), range('src/cache.ts', 7, 9)], complementary: [range('tests/handler.test.ts', 6, 10)] },
  { id: 'fp-subscription-02', split: 'tuning', source: synthetic('subscription-cache'),
    query: 'Where does decodeEvent validate the event schema before returning it?',
    evidence: [range('src/events.ts', 7, 9)], complementary: [] },
  { id: 'fp-access-01', split: 'tuning', source: synthetic('access-gateway'),
    query: 'Why are actors without the required role still allowed into a protected route?',
    evidence: [range('src/policy.ts', 3, 5), range('src/index.ts', 6, 10)], complementary: [range('tests/policy.test.ts', 5, 7)] },
  { id: 'fp-access-02', split: 'tuning', source: synthetic('access-gateway'),
    query: 'Why are denied access decisions left out of the audit trail?',
    evidence: [range('src/index.ts', 6, 10)], complementary: [range('src/audit.ts', 7, 9)] },
  { id: 'fp-access-03', split: 'tuning', source: synthetic('access-gateway'),
    query: 'Why does the admin route only require the member role?',
    evidence: [range('config/routes.json', 2, 2)], complementary: [] },
  { id: 'fp-migration-01', split: 'tuning', source: synthetic('migration-audit'),
    query: 'Why does the deletion planner remove every audit event regardless of its age?',
    evidence: [range('src/retention.ts', 3, 6), range('src/job.ts', 3, 5)], complementary: [] },
  { id: 'fp-migration-02', split: 'tuning', source: synthetic('migration-audit'),
    query: 'Why are all expired identifiers deleted in one unbounded batch?',
    evidence: [range('src/retention.ts', 8, 14), range('src/job.ts', 3, 5)], complementary: [] },
  { id: 'fp-migration-03', split: 'tuning', source: synthetic('migration-audit'),
    query: 'Why is there no index on the audit event creation timestamp?',
    evidence: [range('migrations/001_create_audit.sql', 7, 7)], complementary: [] },
  { id: 'fp-requests-01', split: 'tuning', source: requests,
    query: 'Why does requests keep sending the Authorization header when a redirect goes to a different host?',
    evidence: [range('requests/sessions.py', 213, 220)], complementary: [range('requests/sessions.py', 204, 227)] },
  { id: 'fp-requests-02', split: 'tuning', source: requests,
    query: 'Why can a Session follow redirects forever without any limit?',
    evidence: [range('requests/sessions.py', 113, 114)], complementary: [range('requests/sessions.py', 319, 321)] },
  { id: 'fp-requests-03', split: 'tuning', source: requests,
    query: 'Why does a Session ignore proxy settings from environment variables?',
    evidence: [range('requests/sessions.py', 612, 616)], complementary: [] },
  { id: 'fp-flask-01', split: 'heldout', source: flask,
    query: 'Why does Flask never set the Secure flag on the session cookie?',
    evidence: [range('src/flask/sessions.py', 256, 260), range('src/flask/sessions.py', 410, 419)], complementary: [] },
  { id: 'fp-flask-02', split: 'heldout', source: flask,
    query: 'Why is the session cookie only refreshed when the session was modified, even for permanent sessions?',
    evidence: [range('src/flask/sessions.py', 281, 295)], complementary: [] },
  { id: 'fp-flask-03', split: 'heldout', source: flask,
    query: 'Why does the Flask request object ignore the MAX_CONTENT_LENGTH setting?',
    evidence: [range('src/flask/wrappers.py', 52, 58)], complementary: [] },
];

/** Refuse duplicate IDs and ranges outside the pinned files before any request. */
export function validateFalsePremises(filesFor: (source: FalsePremiseSource) => Readonly<Record<string, string>>): void {
  if (new Set(falsePremiseQuestions.map((question) => question.id)).size !== falsePremiseQuestions.length) throw new Error('duplicate false-premise ID');
  for (const question of falsePremiseQuestions) {
    if (question.evidence.length === 0) throw new Error(`${question.id}: a false premise needs counterevidence`);
    const files = filesFor(question.source);
    for (const unit of [...question.evidence, ...question.complementary]) {
      const lines = files[unit.path]?.replace(/\n$/, '').split('\n').length ?? 0;
      if (unit.startLine < 1 || unit.endLine < unit.startLine || unit.endLine > lines) throw new Error(`${question.id}: invalid range ${unit.path}:${String(unit.startLine)}`);
    }
  }
}
