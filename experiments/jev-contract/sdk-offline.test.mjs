import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function worker(scenario, transport) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./offline-worker.mjs', import.meta.url)), scenario, transport], {
      env: { ...process.env, TYPESAFE_LOG_LEVEL: 'debug', TYPESAFE_API_KEY: 'IGNORED_AMBIENT_KEY',
        TYPESAFE_BASE_URL: 'https://example.invalid', TYPESAFE_DEFAULT_MODEL: 'ambient-model' },
      windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

for (const transport of ['sdk', 'native']) {
  for (const scenario of ['healthy', '429', '500', 'connection-loss', 'pre-abort', 'abort-body', 'timeout-body']) {
    test(transport + ': ' + scenario + ' survives in a separate process without logs or retries', async () => {
      const result = await worker(scenario, transport);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.doesNotMatch(result.stdout, /SYNTHETIC_PROVIDER_KEY|SYNTHETIC_SOURCE_BODY|IGNORED_AMBIENT_KEY/);
      const report = JSON.parse(result.stdout);
      assert.equal(report.dispatches, scenario === 'pre-abort' ? 0 : 1);
      assert.equal(report.outcome, scenario === 'healthy' ? 'success' : 'handled_failure');
    });
  }
}
