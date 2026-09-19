import { TypeSafeClient, noul, VERSION } from '@typesafe-ai/sdk';

const endpoint = 'https://api.typesafe.ai';
const model = 'jev-1.13.0';
const started = performance.now();
const record = {
  checked_at: new Date().toISOString(), node: process.version, sdk: VERSION,
  requested_model: model, source: 'synthetic', retries: 0,
};
const write = (value) => process.stdout.write(JSON.stringify({ ...record, ...value }) + '\n');

if (process.argv.length !== 3 || process.argv[2] !== '--live') {
  write({ status: 'not_dispatched', reason: 'explicit_live_flag_required' });
  process.exitCode = 2;
} else if (!process.env.TYPESAFE_API_KEY?.trim()) {
  write({ status: 'not_dispatched', reason: 'credential_missing' });
  process.exitCode = 2;
} else {
  // Never let provider environment variables change the destination or enable logs.
  const client = new TypeSafeClient({
    apiKey: process.env.TYPESAFE_API_KEY,
    baseURL: endpoint, defaultModel: model, retry: { maxRetries: 0 },
    logLevel: 'off', timeout: 10_000,
    fetch: (url, init) => {
      if (url !== endpoint + '/v1/systemone') throw new Error('unexpected_endpoint');
      return fetch(url, { ...init, redirect: 'error' });
    },
  });
  try {
    const { data, response } = await client.systemOne({
      model, state: 'Synthetic record: the package color is blue.',
      questions: {
        q_blue: noul('Does the record explicitly say the package is blue?'),
        q_red: noul('Does the record explicitly say the package is red?'),
      },
    }, { signal: AbortSignal.timeout(10_000) }).withResponse();
    const validModel = typeof data?.model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(data.model);
    const ids = data?.answers && typeof data.answers === 'object' ? Object.keys(data.answers).sort() : [];
    const correlated = ids.join(',') === 'q_blue,q_red';
    const scores = {};
    if (correlated) {
      for (const id of ids) {
        const answer = data.answers[id];
        if (answer?.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1) {
          scores[id] = answer.noul;
        }
      }
    }
    const knownUsage = ['input_tokens', 'output_tokens'].every(
      (key) => Number.isSafeInteger(data?.usage?.[key]) && data.usage[key] >= 0,
    );
    const valid = validModel && correlated && Object.keys(scores).length === 2 && knownUsage;
    write({
      status: valid ? 'observed' : 'invalid_response', http_status: response.status,
      returned_model: validModel ? data.model : null,
      correlated, scores,
      usage: knownUsage ? {
        input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens,
      } : null,
      elapsed_ms: Math.round(performance.now() - started),
    });
    if (!valid) process.exitCode = 1;
  } catch (error) {
    // Provider error text, headers and raw bodies are never evidence-safe diagnostics.
    write({
      status: 'transport_failure',
      http_status: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
      usage: null, elapsed_ms: Math.round(performance.now() - started),
    });
    process.exitCode = 1;
  }
}
