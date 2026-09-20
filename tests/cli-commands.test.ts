import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { parseCliArguments } from '../src/cli-args.ts';
import type { CliCommand } from '../src/cli-args.ts';
import { executeCommand } from '../src/cli-commands.ts';
import type { CommandDependencies } from '../src/cli-commands.ts';
import type { CliIo } from '../src/cli.ts';
import { createSearchEngine } from '../src/engine.ts';
import { ScoreCache } from '../src/evaluation/cache.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../src/evaluation/jev.ts';
import { CLI_EXIT_CODES } from '../src/search-response.ts';
import { createWorkspace, withRemoteEnabled } from './helpers/search-workspace.ts';

/**
 * CLI command execution (JG-023, specification 2.1 and 4.5).
 *
 * The acceptance criteria drive the cases: `doctor` and `inspect` work with no key
 * and no dispatch, `search --json` returns exactly the engine's canonical contract,
 * exit codes follow the documented table, a multiline question from a file is never
 * interpreted, `cache clear` touches only the configured cache, and stdout carries
 * the result while stderr carries diagnostics.
 */
const spaces: { cleanup(): void }[] = [];

const FILES = {
  'src/cache.ts': 'export function invalidate(userId) {\n  store.delete(userId);\n}\n',
  'src/other.ts': 'export const version = "1.0.0";\n',
  'node_modules/dep/index.js': 'module.exports = 1;\n',
  '.env': 'TOKEN=abc\n',
};

function workspace(configure = withRemoteEnabled): ReturnType<typeof createWorkspace> {
  const space = createWorkspace({ files: FILES, configure });
  spaces.push(space);
  return space;
}

after(() => {
  for (const space of spaces) {
    space.cleanup();
  }
});

class CountingProvider implements ProviderClient {
  readonly model = 'jev-1.13.0';
  calls = 0;

  evaluateBatch(batch: EvaluationBatch): Promise<BatchEvaluation> {
    this.calls += 1;
    const scores = new Map(batch.items.map((item) => [item.id, item.path.includes('cache') ? 0.95 : 0.1] as const));
    return Promise.resolve({
      scores, invalid: [], usage: { inputTokens: 250, outputTokens: 0 },
      requestedModel: this.model, returnedModel: this.model, transmittedBytes: 700, requestId: null,
    });
  }
}

type Captured = { out: string[]; err: string[]; io: CliIo };

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

function parsed(argv: readonly string[], readFile: (path: string) => string = () => ''): CliCommand {
  const result = parseCliArguments(argv, { readFile });
  assert.equal(result.kind, 'command', `argument parsing failed: ${JSON.stringify(result)}`);
  if (result.kind !== 'command') {
    throw new Error('unreachable');
  }
  return result.command;
}

function dependencies(space: ReturnType<typeof createWorkspace>, provider?: ProviderClient): CommandDependencies {
  return {
    env: space.env,
    ...(provider === undefined ? {} : {
      engineFactory: (configuration) => createSearchEngine({ configuration, provider, env: space.env }),
    }),
  };
}

test('doctor runs without a credential and dispatches nothing', async () => {
  const space = workspace();
  const provider = new CountingProvider();
  const captured = capture();
  const code = await executeCommand(parsed(['doctor', '--config', space.configPath]), captured.io, dependencies(space, provider));

  assert.equal(code, CLI_EXIT_CODES.complete);
  assert.equal(provider.calls, 0);
  const text = captured.out.join('\n');
  assert.ok(text.includes('repository root'));
  assert.ok(text.includes('TYPESAFE_API_KEY'));
  assert.ok(text.includes('all disabled (null)'));
  assert.equal(captured.err.length, 0, 'a healthy doctor writes nothing to stderr');
});

test('cache clear reports a failed purge instead of claiming success', async (t) => {
  const space = workspace(); const captured = capture();
  t.mock.method(ScoreCache.prototype, 'clear', function (this: ScoreCache) { this.stats.failures++; return 0; });
  const code = await executeCommand(parsed(['cache', 'clear', '--config', space.configPath]), captured.io, dependencies(space));
  assert.equal(code, CLI_EXIT_CODES.error); assert.equal(captured.out.length, 0);
  assert.match(captured.err.join(''), /could not be completely cleared/);
});

test('inspect reports scope, exclusions, fragments and estimates without a provider call', async () => {
  const space = workspace();
  const provider = new CountingProvider();
  const captured = capture();
  const code = await executeCommand(
    parsed(['inspect', '--config', space.configPath, '--scope', 'src', '--json']),
    captured.io, dependencies(space, provider),
  );

  assert.equal(code, CLI_EXIT_CODES.complete);
  assert.equal(provider.calls, 0);
  const report = JSON.parse(captured.out.join('')) as {
    scope: string[]; files: { eligible: number; excluded_by_reason: Record<string, number> };
    fragments: { total: number | null }; estimates: { cost_usd: number | null; cache_hits: null; requests: number };
  };
  assert.deepEqual(report.scope, ['src']);
  assert.equal(report.files.eligible, 2);
  assert.equal(report.fragments.total, 2);
  assert.equal(report.estimates.cache_hits, null, 'an unknown quantity stays identified as unknown');
  assert.equal(report.estimates.cost_usd, null, 'no USD estimate without a dated pricing record');
  assert.ok(report.estimates.requests >= 1);
});

test('the human inspect rendering names what it could not count', async () => {
  const space = workspace();
  const captured = capture();
  await executeCommand(parsed(['inspect', '--config', space.configPath]), captured.io, dependencies(space));
  const text = captured.out.join('\n');
  assert.ok(text.includes('cache hits         unknown without a search question'));
  assert.ok(text.includes('estimated cost     unknown'));
  assert.ok(/excluded by reason|excluded         none/.test(text));
});

test('search --json prints the canonical contract on stdout and measurements on stderr', async () => {
  const space = workspace();
  const provider = new CountingProvider();
  const captured = capture();
  const code = await executeCommand(
    parsed(['search', '--config', space.configPath, '--query', 'cache invalidation', '--json']),
    captured.io, dependencies(space, provider),
  );

  assert.equal(code, CLI_EXIT_CODES.complete);
  assert.equal(captured.out.length, 1, 'stdout carries exactly the requested result');
  const payload = JSON.parse(captured.out[0] ?? '') as { status: string; excerpts: { path: string }[] };
  assert.equal(payload.status, 'complete');
  assert.deepEqual(payload.excerpts.map((excerpt) => excerpt.path), ['src/cache.ts']);
  assert.ok(captured.err.join('\n').includes('tiktoken@1.0.22/cl100k_base tokens'), 'the measurement is a diagnostic');
});

test('CLI search applies both the default and maximum response budget from trusted configuration', async () => {
  const space = workspace((base) => ({ ...withRemoteEnabled(base), search: { ...base.search, default_response_tokens: 6_000, max_response_tokens: 20_000 } }));
  const provider = new CountingProvider();
  for (const budget of [undefined, 20_000, 20_001]) {
    const captured = capture();
    const code = await executeCommand(parsed(['search', '--config', space.configPath, '--query', 'cache', '--json',
      ...(budget === undefined ? [] : ['--max-context-tokens', String(budget)])]), captured.io, dependencies(space, provider));
    const outcome = JSON.parse(captured.out[0]!) as { report?: { response_budget: { requested_tokens: number } }; error?: { code: string } };
    if (budget === 20_001) { assert.equal(code, CLI_EXIT_CODES.rejected); assert.equal(outcome.error?.code, 'INVALID_REQUEST'); }
    else { assert.equal(code, CLI_EXIT_CODES.complete); assert.equal(outcome.report?.response_budget.requested_tokens, budget ?? 6_000); }
  }
});

test('a multiline question from a file is used verbatim, never interpreted', async () => {
  const space = workspace();
  const provider = new CountingProvider();
  const captured = capture();
  const question = 'where is the cache invalidated?\n$(rm -rf /) `echo hi`\n';
  const command = parsed(
    ['search', '--config', space.configPath, '--query-file', 'question.txt', '--json'],
    (path) => (path === 'question.txt' ? question : ''),
  );
  assert.equal(command.kind, 'search');
  if (command.kind !== 'search') {
    return;
  }
  assert.equal(command.request.query, question, 'the question keeps its newlines and shell-looking text');

  const code = await executeCommand(command, captured.io, dependencies(space, provider));
  assert.equal(code, CLI_EXIT_CODES.complete);
  assert.equal(provider.calls, 1);
});

test('exit codes follow the documented table', async () => {
  const space = workspace();
  const provider = new CountingProvider();

  const complete = capture();
  assert.equal(
    await executeCommand(parsed(['search', '--config', space.configPath, '--query', 'cache', '--json']), complete.io, dependencies(space, provider)),
    CLI_EXIT_CODES.complete,
  );

  const rejected = capture();
  assert.equal(
    await executeCommand(parsed(['doctor', '--config', 'missing-config.json']), rejected.io, dependencies(space)),
    CLI_EXIT_CODES.rejected,
  );
  assert.ok(rejected.err.join('\n').includes('INVALID_CONFIG'));

  // A budget that cannot hold the mandatory report is a rejection, not a crash. The
  // report echoes the requested scope, so a wide scope with the smallest legal budget
  // is the case the specification describes (RESPONSE_BUDGET_TOO_SMALL, section 8.2).
  const wideScope = Array.from(
    { length: 32 },
    (_, index) => ['--scope', `src/services/very/deeply/nested/module-${String(index).padStart(2, '0')}`],
  ).flat();
  const budget = capture();
  assert.equal(
    await executeCommand(
      parsed(['search', '--config', space.configPath, '--query', 'cache', ...wideScope, '--max-context-tokens', '1024', '--json']),
      budget.io, dependencies(space, provider),
    ),
    CLI_EXIT_CODES.rejected,
  );
  const refusal = JSON.parse(budget.out[0] ?? '') as { error: { code: string } };
  assert.equal(refusal.error.code, 'RESPONSE_BUDGET_TOO_SMALL');
});

test('a partial result exits 3 and still prints its evidence', async () => {
  const space = workspace();
  const failing: ProviderClient = {
    model: 'jev-1.13.0',
    evaluateBatch: (batch: EvaluationBatch) => Promise.resolve({
      scores: new Map(batch.items.slice(0, 1).map((item) => [item.id, 0.95] as const)),
      invalid: batch.items.slice(1).map((item) => ({ id: item.id, reason: 'missing' as const })),
      usage: { inputTokens: 10, outputTokens: 0 },
      requestedModel: 'jev-1.13.0', returnedModel: 'jev-1.13.0', transmittedBytes: 100, requestId: null,
    }),
  };
  const captured = capture();
  const code = await executeCommand(
    parsed(['search', '--config', space.configPath, '--query', 'cache invalidation', '--json']),
    captured.io, dependencies(space, failing),
  );
  assert.equal(code, CLI_EXIT_CODES.partial);
  const payload = JSON.parse(captured.out[0] ?? '') as { status: string; report: { stop_reasons: string[] } };
  assert.equal(payload.status, 'partial');
  assert.ok(payload.report.stop_reasons.includes('INVALID_PROVIDER_RESPONSE'));
});

test('the human rendering measures itself separately from the response budget', async () => {
  const space = workspace();
  const provider = new CountingProvider();
  const captured = capture();
  await executeCommand(
    parsed(['search', '--config', space.configPath, '--query', 'cache invalidation']),
    captured.io, dependencies(space, provider),
  );
  const diagnostics = captured.err.join('\n');
  assert.ok(diagnostics.includes('human rendering measured at'));
  assert.ok(diagnostics.includes('human and --json payloads are budgeted separately'));
  assert.ok(captured.out.join('\n').includes('src/cache.ts'));
});

test('cache clear removes only the configured cache and writes nothing to the repository', async () => {
  const space = workspace();
  const provider = new CountingProvider();
  const search = capture();
  await executeCommand(
    parsed(['search', '--config', space.configPath, '--query', 'cache invalidation', '--json']),
    search.io, dependencies(space, provider),
  );

  const cleared = capture();
  const code = await executeCommand(parsed(['cache', 'clear', '--config', space.configPath]), cleared.io, dependencies(space, provider));
  assert.equal(code, CLI_EXIT_CODES.complete);
  assert.ok(cleared.out.join('\n').includes('removed'));
  assert.ok(cleared.out.join('\n').includes(space.loaded.cacheDirectory));

  const again = capture();
  await executeCommand(
    parsed(['search', '--config', space.configPath, '--query', 'cache invalidation', '--json']),
    again.io, dependencies(space, provider),
  );
  assert.equal(provider.calls, 2, 'after a clear, the same search evaluates again');
});

test('a search without remote evaluation is refused before any dispatch', async () => {
  const space = workspace((config) => config);
  const captured = capture();
  const code = await executeCommand(
    parsed(['search', '--config', space.configPath, '--query', 'cache invalidation', '--json']),
    captured.io, dependencies(space),
  );
  assert.equal(code, CLI_EXIT_CODES.rejected);
  const payload = JSON.parse(captured.out[0] ?? '') as { error: { code: string } };
  assert.equal(payload.error.code, 'REMOTE_DISABLED');
});
