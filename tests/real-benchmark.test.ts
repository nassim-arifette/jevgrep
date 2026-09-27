import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePairedRuns, bootstrapMeanDifference, scoreSubmission, type AgentRun } from '../scripts/bench/agent.ts';
import { runAgent, type ChatModel } from '../scripts/bench/agent-loop.ts';
import { freezeMismatches, type Freeze } from '../scripts/bench/freeze.ts';
import { classifyHunk, loadManifest, parsePatch, tarFiles, unitsFromLines } from '../scripts/bench/real-tasks.ts';
import { latencySummary, plannedSummary } from '../scripts/bench/report.ts';
import { localizationMetrics } from '../scripts/bench/retrieval.ts';

test('real-task manifest separates splits, categories and required from complementary evidence', () => {
  const manifest = loadManifest();
  assert.ok(manifest.tasks.length > 0);
  assert.deepEqual(new Set(manifest.tasks.map((task) => `${task.repository}:${task.split}`)), new Set(['psf/requests:dev', 'pallets/flask:heldout']));
  for (const task of manifest.tasks) {
    assert.match(task.baseCommit, /^[0-9a-f]{40}$/);
    assert.match(task.snapshotHash, /^[0-9a-f]{64}$/);
    assert.ok(task.queries.some((query) => query.category === 'change-localization'), task.id);
    for (const query of task.queries) assert.ok(query.evidence.length > 0, query.id);
  }
});

test('patch parsing maps hunks to pre-change lines and classifies non-edits', () => {
  const [file] = parsePatch('diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -2,3 +2,3 @@\n a\n-b\n+c\n d\n');
  assert.deepEqual(file!.hunks[0]!.lines, [3, 3]);
  assert.equal(classifyHunk({ removed: ['x = 1'], added: ['x  =  1'], lines: [1] }, 'x = 1\n'), 'ignored');
  assert.equal(classifyHunk({ removed: [], added: ['import os'], lines: [1] }, 'x = 1\n'), 'ignored');
  assert.equal(classifyHunk({ removed: [], added: ['def added():', '    pass'], lines: [1] }, 'x = 1\n'), 'placement');
  assert.equal(classifyHunk({ removed: ['    return a'], added: ['    return b'], lines: [2] }, 'def f():\n    return a\n'), 'edit');
  assert.deepEqual(unitsFromLines('m.py', [5, 1, 2, 9]), [{ path: 'm.py', startLine: 1, endLine: 5 }, { path: 'm.py', startLine: 9, endLine: 9 }]);
});

test('snapshot export reads regular files from a git tar stream without an external tar', () => {
  const entry = (name: string, type: string, body: Buffer = Buffer.alloc(0), prefix = ''): Buffer => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    header.write(type, 156, 'latin1');
    header.write(prefix, 345, 'utf8');
    return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  };
  const pax = (key: string, value: string): Buffer => {
    const text = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(text);
    while (String(length).length + Buffer.byteLength(text) !== length) length = String(length).length + Buffer.byteLength(text);
    return Buffer.from(`${String(length)}${text}`);
  };
  const long = `${'nested/'.repeat(30)}long.py`;
  const archive = Buffer.concat([
    entry('pax_global_header', 'g', pax('comment', '0'.repeat(40))),
    entry('pkg/', '5'),
    entry('pkg/a.py', '0', Buffer.from('a = 1\n')),
    entry('b.py', '0', Buffer.from('b = 2\n'), 'pkg/deep'),
    entry('0123.paxheader', 'x', pax('path', long)),
    entry('0123.data', '0', Buffer.from('c = 3\n')),
    entry('pkg/link.py', '2'),
    Buffer.alloc(1024),
  ]);
  assert.deepEqual(tarFiles(archive).map(({ path, bytes }) => [path, bytes.toString()]), [
    ['pkg/a.py', 'a = 1\n'], ['pkg/deep/b.py', 'b = 2\n'], [long, 'c = 3\n'],
  ]);
  assert.throws(() => tarFiles(archive.subarray(0, archive.indexOf('a = 1') + 3)), /malformed tar entry/);
});

test('localization metrics keep complementary evidence out of strict recall', () => {
  const question = { evidence: [{ path: 'a.py', startLine: 10, endLine: 12 }], complementary: [{ path: 't.py', startLine: 1, endLine: 2 }] };
  const excerpt = (path: string, start: number, end: number) => ({ path, start_line: start, end_line: end, file_sha256: '0'.repeat(64), score: 0.9, code: 'x' });
  const outcome = { status: 'complete', excerpts: [excerpt('t.py', 1, 2), excerpt('a.py', 11, 11)], report: { scope_fully_scanned: true } } as never;
  const metrics = localizationMetrics(question, outcome)!;
  assert.equal(metrics.fileRecall, 1);
  assert.equal(metrics.firstOverlapRank, 2);
  assert.equal(metrics.complementaryCoverage, 1);
});

test('freeze mismatches name every drifted field', () => {
  const identity = { split: 'heldout', datasetHash: 'd', sourceHash: 's', harnessHash: 'h', packageLockHash: 'p', settingsHash: 'x', model: 'm' };
  const frozen: Freeze = { kind: 'benchmark-freeze', createdAt: '2026-01-01T00:00:00Z', ...identity };
  assert.deepEqual(freezeMismatches(frozen, identity), []);
  assert.deepEqual(freezeMismatches(frozen, { ...identity, datasetHash: 'e', model: 'n' }), ['datasetHash', 'model']);
});

test('summaries keep planned denominators and withhold p95 below the sample floor', () => {
  assert.deepEqual(plannedSummary(['a', 'b', 'c'], [{ id: 'a', metrics: 1 }, { id: 'b', metrics: null, error: 'rate limit' }]).completionRate, 1 / 3);
  assert.equal(latencySummary([1, 2, 3]).p95, null);
  assert.ok(latencySummary(Array.from({ length: 20 }, (_, index) => index)).p95 !== null);
  assert.throws(() => plannedSummary(['a'], [{ id: 'z', metrics: 1 }]));
});

test('agent submissions score by overlap with slack and file identity', () => {
  const required = [{ path: 'a.py', startLine: 20, endLine: 22 }];
  assert.deepEqual(scoreSubmission([{ path: 'a.py', startLine: 24, endLine: 30 }], required), { success: true, fileHit: true });
  assert.deepEqual(scoreSubmission([{ path: 'a.py', startLine: 40, endLine: 50 }], required), { success: false, fileHit: true });
});

const run = (task: string, arm: AgentRun['arm'], success: boolean, toolCalls: number, status: AgentRun['status'] = 'submitted'): AgentRun => ({
  task, repository: 'r', arm, repeat: 0, status, error: null, success, fileHit: success, toolCalls, turns: 1, filesOpened: 1,
  fileRereads: 0, jevCalls: arm === 'jevgrep' ? 1 : 0, agentInputTokens: 100, agentOutputTokens: 10, agentCostUsd: 0.01,
  jevInputTokens: arm === 'jevgrep' ? 50 : 0, jevCostUsd: 0, totalCostUsd: 0.01, latencyMs: 10, initializationMs: null,
});

test('paired analysis only compares pairs where both arms completed and withholds small-sample intervals', () => {
  const runs = [run('t1', 'baseline', false, 10), run('t1', 'jevgrep', true, 4), run('t2', 'baseline', true, 8), run('t2', 'jevgrep', true, 6, 'error')];
  const analysis = analyzePairedRuns(runs);
  assert.equal(analysis.overall.pairs, 1);
  assert.equal(analysis.overall.wins, 1);
  assert.equal(analysis.overall.delta.success.mean, 1);
  assert.equal(analysis.overall.delta.success.low, null);
  assert.equal(analysis.overall.jevgrep.errors, 1);
  const interval = bootstrapMeanDifference(Array.from({ length: 6 }, (_, index) => [index % 2, 1]), 500, 3);
  assert.ok(interval.low !== null && interval.high !== null && interval.low <= interval.mean! && interval.mean! <= interval.high);
  assert.deepEqual(interval, bootstrapMeanDifference(Array.from({ length: 6 }, (_, index) => [index % 2, 1]), 500, 3));
});

test('agent loop counts tools, rereads and unknown usage against a scripted model', async () => {
  const script = [
    [{ name: 'read_file', args: { path: 'a.py', start_line: 1, end_line: 2 } }],
    [{ name: 'read_file', args: { path: 'a.py', start_line: 2, end_line: 3 } }, { name: 'jevgrep_search', args: { query: 'where' } }],
    [{ name: 'submit_locations', args: { locations: [{ path: 'a.py', start_line: 2, end_line: 2 }] } }],
  ];
  let turn = 0;
  const model: ChatModel = async (_messages, tools) => {
    assert.ok(tools.some((tool) => tool.function.name === 'jevgrep_search'));
    const calls = script[turn]!.map((call, index) => ({ id: `${turn}-${index}`, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.args) } }));
    turn += 1;
    return { message: { role: 'assistant', content: null, tool_calls: calls }, usage: { inputTokens: 10, outputTokens: turn === 2 ? null : 1, costUsd: null } };
  };
  const trace = await runAgent({ model, files: { 'a.py': 'x\ny\nz\n' }, issue: 'bug', jevgrep: async () => ({ text: 'a.py:2-2', inputTokens: 5, costUsd: 0, paths: ['a.py'] }) });
  assert.equal(trace.status, 'submitted');
  assert.deepEqual(trace.submitted, [{ path: 'a.py', startLine: 2, endLine: 2 }]);
  assert.equal(trace.toolCalls, 4);
  assert.equal(trace.filesOpened, 1);
  assert.equal(trace.fileRereads, 1);
  assert.equal(trace.jevCalls, 1);
  assert.equal(trace.jevInputTokens, 5);
  assert.equal(trace.agentInputTokens, 30);
  assert.equal(trace.agentOutputTokens, null);
});
