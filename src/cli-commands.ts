/**
 * CLI command execution (JG-023).
 *
 * The parser (`cli-args.ts`) decides *what* was asked; this module performs it
 * against the shared engine and maps the outcome onto the documented exit codes of
 * specification section 4.5. It holds no search logic of its own.
 *
 * Output discipline: stdout carries exactly the result that was asked for — the
 * canonical JSON payload, the human rendering, a report — and stderr carries
 * diagnostics, measurements and configuration problems. A pipeline can therefore keep
 * the evidence on stdout even when the exit code is non-zero.
 *
 * `doctor`, `inspect` and `cache clear` never need a credential and never dispatch a
 * provider request.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import type { CliCommand } from './cli-args.ts';
import { renderHumanOutcome } from './cli-render.ts';
import type { CliIo } from './cli.ts';
import { ConfigurationError, doctorReport, loadConfiguration, renderDoctorReport } from './config.ts';
import type { LoadedConfiguration } from './config.ts';
import { createSearchError } from './contracts.ts';
import { SearchEngine, createSearchEngine } from './engine.ts';
import { ScoreCache } from './evaluation/cache.ts';
import { inspectScope, renderInspection } from './inspect.ts';
import { runMcpServer } from './mcp.ts';
import { CLI_EXIT_CODES, toCliSearchResponse } from './search-response.ts';
import { REFERENCE_COUNTER_ID, referenceCounter } from './response/token-counter.ts';

export type CommandDependencies = {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly serverVersion?: string;
  /** Stdio streams for `mcp`; defaults to this process's own. */
  readonly input?: Readable;
  readonly output?: Writable;
  readonly errorOutput?: Writable;
  /** User interruption, wired to SIGINT by the entry point. */
  readonly signal?: AbortSignal;
  /** Test seam: builds the engine, for example with a scripted provider. */
  readonly engineFactory?: (configuration: LoadedConfiguration) => SearchEngine;
};

/** Load the trusted configuration, reporting a configuration problem as a rejection. */
function load(command: { config: string }, io: CliIo, deps: CommandDependencies): LoadedConfiguration | number {
  try {
    return loadConfiguration(command.config, {
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      io.err(`jevgrep: ${cause.code}: ${cause.detail}`);
      return CLI_EXIT_CODES.rejected;
    }
    io.err(`jevgrep: the configuration could not be loaded: ${cause instanceof Error ? cause.message : 'unknown failure'}`);
    return CLI_EXIT_CODES.error;
  }
}

function engineFor(configuration: LoadedConfiguration, deps: CommandDependencies): SearchEngine {
  return deps.engineFactory?.(configuration) ?? createSearchEngine({
    configuration,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  });
}

/** Run one parsed command and return the process exit code. */
export async function executeCommand(
  command: CliCommand,
  io: CliIo,
  deps: CommandDependencies = {},
): Promise<number> {
  switch (command.kind) {
    case 'doctor':
      return runDoctor(command, io, deps);
    case 'inspect':
      return runInspect(command, io, deps);
    case 'search':
      return runSearch(command, io, deps);
    case 'cache-clear':
      return runCacheClear(command, io, deps);
    case 'mcp':
      return runMcp(command, io, deps);
  }
}

function runDoctor(command: Extract<CliCommand, { kind: 'doctor' }>, io: CliIo, deps: CommandDependencies): number {
  const loaded = load(command, io, deps);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const report = doctorReport(loaded, deps.env ?? process.env, REFERENCE_COUNTER_ID);
  for (const line of renderDoctorReport(report)) {
    io.out(line);
  }
  return CLI_EXIT_CODES.complete;
}

function runInspect(command: Extract<CliCommand, { kind: 'inspect' }>, io: CliIo, deps: CommandDependencies): number {
  const loaded = load(command, io, deps);
  if (typeof loaded === 'number') {
    return loaded;
  }
  try {
    const report = inspectScope(loaded, { scope: command.scope });
    if (command.json) {
      io.out(JSON.stringify(report));
    } else {
      for (const line of renderInspection(report)) {
        io.out(line);
      }
    }
    return CLI_EXIT_CODES.complete;
  } catch (cause) {
    io.err(`jevgrep: the scope could not be inspected: ${cause instanceof Error ? cause.message : 'unknown failure'}`);
    return CLI_EXIT_CODES.rejected;
  }
}

async function runSearch(
  command: Extract<CliCommand, { kind: 'search' }>,
  io: CliIo,
  deps: CommandDependencies,
): Promise<number> {
  const loaded = load(command, io, deps);
  if (typeof loaded === 'number') {
    return loaded;
  }

  const engine = engineFor(loaded, deps);
  const { outcome, measuredTokens } = await engine.search(command.request, {
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });

  if (command.json) {
    try {
      const response = toCliSearchResponse(outcome, referenceCounter);
      io.out(response.stdout);
      if (measuredTokens !== null) {
        io.err(`jevgrep: response measured at ${String(measuredTokens)} ${REFERENCE_COUNTER_ID} tokens of ${String(command.request.max_context_tokens)}`);
      }
      return response.exitCode;
    } catch (cause) {
      // A payload that does not satisfy its own contract is a defect, not a result.
      io.err(`jevgrep: the produced response failed contract validation: ${cause instanceof Error ? cause.message : 'unknown failure'}`);
      io.out(JSON.stringify(createSearchError('RESOURCE_EXHAUSTED', 'invalid-response')));
      return CLI_EXIT_CODES.error;
    }
  }

  let human;
  try {
    human = renderHumanOutcome(outcome, referenceCounter);
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    io.out('jevgrep: rejected\nerror: RESPONSE_BUDGET_TOO_SMALL\nIncrease the human response budget or narrow the scope.');
    return CLI_EXIT_CODES.rejected;
  }
  io.out(human.text);
  io.err(`jevgrep: human rendering measured at ${String(human.tokenCount)} ${human.counter} tokens, `
    + `${String(human.byteCount)} bytes, ${String(human.excerptCount)} excerpt(s); `
    + `human and --json payloads are budgeted separately`);
  const cancelled = 'error' in outcome
    ? outcome.error.code === 'CANCELLED'
    : outcome.report.stop_reasons.includes('CANCELLED');
  return cancelled ? CLI_EXIT_CODES.interrupted : CLI_EXIT_CODES[outcome.status];
}

function runCacheClear(
  command: Extract<CliCommand, { kind: 'cache-clear' }>,
  io: CliIo,
  deps: CommandDependencies,
): number {
  const loaded = load(command, io, deps);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const cache = new ScoreCache({
    directory: loaded.cacheDirectory,
    enabled: true,
    ttlSeconds: loaded.config.cache.ttl_seconds,
    maxBytes: loaded.config.cache.max_bytes,
  });
  const removed = cache.clear();
  io.out(`removed ${String(removed)} cached evaluation(s) from ${loaded.cacheDirectory}`);
  io.err('jevgrep: only the cache configured by this configuration was cleared; no repository file was written');
  return CLI_EXIT_CODES.complete;
}

async function runMcp(
  command: Extract<CliCommand, { kind: 'mcp' }>,
  io: CliIo,
  deps: CommandDependencies,
): Promise<number> {
  const loaded = load(command, io, deps);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const engine = engineFor(loaded, deps);
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const errorOutput = deps.errorOutput ?? process.stderr;
  errorOutput.write(`jevgrep: mcp server ready for ${loaded.repositoryRoot} (no scan, no provider call at startup)\n`);

  await runMcpServer({
    engine, input, output, errorOutput,
    serverVersion: deps.serverVersion ?? readVersionQuietly(),
  });
  void io;
  return CLI_EXIT_CODES.complete;
}

function readVersionQuietly(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
