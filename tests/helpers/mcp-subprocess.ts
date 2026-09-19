/**
 * Subprocess launcher for the MCP server tests (JG-024, and the interoperability
 * probe of JG-006).
 *
 * It starts the real server over real stdio with a scripted provider, so the tests
 * observe process behaviour — stdout purity, cancellation, stdin EOF — without a
 * credential and without a network call.
 *
 * Usage: node tests/helpers/mcp-subprocess.ts <trusted-config-path>
 */
import process from 'node:process';

import { loadConfiguration } from '../../src/config.ts';
import { createSearchEngine } from '../../src/engine.ts';
import type { BatchEvaluation, EvaluationBatch, ProviderClient } from '../../src/evaluation/jev.ts';
import { runMcpServer } from '../../src/mcp.ts';

class DeterministicProvider implements ProviderClient {
  readonly model = 'jev-1.13.0';

  evaluateBatch(batch: EvaluationBatch): Promise<BatchEvaluation> {
    const scores = new Map<string, number>();
    for (const item of batch.items) {
      scores.set(item.id, item.path.includes('cache') ? 0.9 : 0.1);
    }
    return Promise.resolve({
      scores, invalid: [], usage: { inputTokens: 100, outputTokens: 0 },
      requestedModel: this.model, returnedModel: this.model,
      transmittedBytes: 1_024, requestId: 'req-subprocess',
    });
  }
}

const configPath = process.argv[2];
if (configPath === undefined) {
  process.stderr.write('usage: mcp-subprocess.ts <config-path>\n');
  process.exit(2);
}

const configuration = loadConfiguration(configPath, { env: process.env });
const engine = createSearchEngine({ configuration, provider: new DeterministicProvider(), env: process.env });

await runMcpServer({
  engine,
  input: process.stdin,
  output: process.stdout,
  errorOutput: process.stderr,
  serverVersion: '0.0.0-test',
});
