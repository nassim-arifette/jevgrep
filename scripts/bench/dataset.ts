import { join } from 'node:path';
import { fixtureRoot, readTree, treeHash } from './common.ts';

export type Evidence = { path: string; startLine: number; endLine: number };
export type RetrievalQuestion = {
  id: string; repository: keyof typeof fixtureHashes; query: string;
  kind: 'behavior' | 'exact' | 'reformulation' | 'cross-file' | 'negative';
  /** Every range is a required evidence unit, not an alternative correct answer. */
  evidence: readonly Evidence[];
};

export const datasetVersion = 'synthetic-pilot-1';
export const fixtureHashes = {
  'access-gateway': 'd58be410d25b02c34d1e4990799d7017d72f979a987fb0ea4f2bd8f380182052',
  'subscription-cache': '1e3139ea7a9ac4a0a42f9fda7b897787d29cf775cb5e464a31013dca6b169b34',
  'migration-audit': 'a031fc80287f79ef680a68600b05086c1286d82cc3604886c6aab8c166a4f8c2',
} as const;

const range = (path: string, startLine: number, endLine: number): Evidence => ({ path, startLine, endLine });
const policy = range('src/policy.ts', 3, 5);
const denial = range('src/policy.ts', 7, 9);
const authorization = range('src/index.ts', 6, 10);
const audit = range('src/audit.ts', 7, 9);
const handler = range('src/handler.ts', 4, 9);
const invalidation = range('src/cache.ts', 7, 9);
const decoding = range('src/events.ts', 7, 9);
const expiry = range('src/retention.ts', 3, 6);
const batches = range('src/retention.ts', 8, 14);
const deletion = range('src/job.ts', 3, 5);

export const questions: readonly RetrievalQuestion[] = [
  { id: 'access-01', repository: 'access-gateway', kind: 'behavior', query: 'Where is possession of a required role checked?', evidence: [policy] },
  { id: 'access-02', repository: 'access-gateway', kind: 'reformulation', query: 'What makes a visitor eligible to enter a protected route?', evidence: [policy] },
  { id: 'access-03', repository: 'access-gateway', kind: 'exact', query: 'Find the implementation of explainDenial.', evidence: [denial] },
  { id: 'access-04', repository: 'access-gateway', kind: 'behavior', query: 'Where are allowed and denied access decisions recorded?', evidence: [audit, authorization] },
  { id: 'access-05', repository: 'access-gateway', kind: 'cross-file', query: 'Trace the authorization decision from the role check to its audit record.', evidence: [policy, authorization, audit] },
  { id: 'access-06', repository: 'access-gateway', kind: 'behavior', query: 'Which role is configured for the admin route?', evidence: [range('config/routes.json', 2, 2)] },
  { id: 'access-07', repository: 'access-gateway', kind: 'cross-file', query: 'Show the role check and the test that rejects a member when administrator is required.', evidence: [policy, range('tests/policy.test.ts', 5, 7)] },
  { id: 'access-08', repository: 'access-gateway', kind: 'behavior', query: 'How can a caller retrieve the accumulated audit trail?', evidence: [range('src/index.ts', 12, 14)] },
  { id: 'access-09', repository: 'access-gateway', kind: 'negative', query: 'Where are login attempts rate-limited by IP address?', evidence: [] },
  { id: 'access-10', repository: 'access-gateway', kind: 'negative', query: 'Where does this application generate PDF invoices?', evidence: [] },
  { id: 'subscription-01', repository: 'subscription-cache', kind: 'behavior', query: 'Where is a user removed from the in-memory cache?', evidence: [invalidation] },
  { id: 'subscription-02', repository: 'subscription-cache', kind: 'reformulation', query: 'How is stale cached user data discarded after a plan update?', evidence: [handler, invalidation] },
  { id: 'subscription-03', repository: 'subscription-cache', kind: 'exact', query: 'Find the implementation of decodeEvent.', evidence: [decoding] },
  { id: 'subscription-04', repository: 'subscription-cache', kind: 'cross-file', query: 'Trace a subscription.changed webhook from JSON decoding to cache deletion.', evidence: [decoding, handler, invalidation] },
  { id: 'subscription-05', repository: 'subscription-cache', kind: 'behavior', query: 'Where is a user payload inserted into the cache?', evidence: [range('src/cache.ts', 3, 5)] },
  { id: 'subscription-06', repository: 'subscription-cache', kind: 'behavior', query: 'How is a cached payload looked up by user ID?', evidence: [range('src/cache.ts', 11, 13)] },
  { id: 'subscription-07', repository: 'subscription-cache', kind: 'cross-file', query: 'Show the cache invalidation triggered by a subscription change and the assertion that verifies it.', evidence: [handler, invalidation, range('tests/handler.test.ts', 6, 10)] },
  { id: 'subscription-08', repository: 'subscription-cache', kind: 'behavior', query: 'What fields make up a subscription-change event?', evidence: [range('src/events.ts', 1, 5)] },
  { id: 'subscription-09', repository: 'subscription-cache', kind: 'negative', query: 'Where are cached users automatically expired using a timer?', evidence: [] },
  { id: 'subscription-10', repository: 'subscription-cache', kind: 'negative', query: 'Where does the webhook handler send notification emails?', evidence: [] },
  { id: 'migration-01', repository: 'migration-audit', kind: 'behavior', query: 'How is the timestamp cutoff for expired audit events calculated?', evidence: [expiry] },
  { id: 'migration-02', repository: 'migration-audit', kind: 'reformulation', query: 'Which records are considered old enough to remove?', evidence: [expiry] },
  { id: 'migration-03', repository: 'migration-audit', kind: 'exact', query: 'Find the implementation of planDeletion.', evidence: [deletion] },
  { id: 'migration-04', repository: 'migration-audit', kind: 'cross-file', query: 'Trace how the deletion job selects expired events and splits their identifiers into batches.', evidence: [deletion, expiry, batches] },
  { id: 'migration-05', repository: 'migration-audit', kind: 'behavior', query: 'Where are auditDays and deleteBatchSize declared in configuration?', evidence: [range('config/retention.json', 2, 3)] },
  { id: 'migration-06', repository: 'migration-audit', kind: 'behavior', query: 'Where is the SQL index on audit event creation timestamps defined?', evidence: [range('migrations/001_create_audit.sql', 7, 7)] },
  { id: 'migration-07', repository: 'migration-audit', kind: 'cross-file', query: 'Show the declared retention settings and the values actually used by the deletion planner.', evidence: [range('config/retention.json', 2, 3), deletion] },
  { id: 'migration-08', repository: 'migration-audit', kind: 'behavior', query: 'How are identifiers partitioned into bounded groups for deletion?', evidence: [batches] },
  { id: 'migration-09', repository: 'migration-audit', kind: 'negative', query: 'Where does the deletion job execute a SQL DELETE against the database?', evidence: [] },
  { id: 'migration-10', repository: 'migration-audit', kind: 'negative', query: 'Where are deleted audit events archived to object storage?', evidence: [] },
];

/** Refuse silent drift in either fixtures or annotation ranges before any request. */
export function validateDataset(): Map<RetrievalQuestion['repository'], Record<string, string>> {
  if (new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error('duplicate question ID');
  const repositories = new Map<RetrievalQuestion['repository'], Record<string, string>>();
  for (const name of Object.keys(fixtureHashes) as RetrievalQuestion['repository'][]) {
    const files = readTree(join(fixtureRoot, name));
    if (treeHash(files) !== fixtureHashes[name]) throw new Error(`fixture ${name} changed; review annotations and version the dataset`);
    repositories.set(name, files);
  }
  for (const question of questions) {
    if ((question.kind === 'negative') !== (question.evidence.length === 0)) throw new Error(`invalid labels for ${question.id}`);
    for (const evidence of question.evidence) {
      const text = repositories.get(question.repository)?.[evidence.path];
      const lines = text?.replace(/\n$/, '').split('\n').length ?? 0;
      if (evidence.startLine < 1 || evidence.endLine < evidence.startLine || evidence.endLine > lines) {
        throw new Error(`invalid evidence range for ${question.id}`);
      }
    }
  }
  return repositories;
}
