import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TypeSafeClient, noul, VERSION } from '@typesafe-ai/sdk';

const [scenario, transport] = process.argv.slice(2);
const cases = ['healthy', '429', '500', 'connection-loss', 'pre-abort', 'abort-body', 'timeout-body'];
assert(cases.includes(scenario));
assert(['sdk', 'native'].includes(transport));
const key = 'SYNTHETIC_PROVIDER_KEY_DO_NOT_LOG';
const state = 'SYNTHETIC_SOURCE_BODY_DO_NOT_LOG';
const controller = new AbortController();
let dispatches = 0;
let headersReceived = false;
let contractObserved = false;
const server = createServer(async (request, response) => {
  dispatches++;
  let body = '';
  for await (const chunk of request) body += chunk;
  assert.equal(request.url, '/v1/systemone');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer ' + key);
  const parsed = JSON.parse(body);
  assert.equal(parsed.state, state);
  assert.deepEqual(Object.keys(parsed.questions).sort(), ['q_blue', 'q_red']);
  contractObserved = true;
  if (scenario === 'connection-loss') { request.socket.destroy(); return; }
  if (scenario === '429' || scenario === '500') {
    response.writeHead(Number(scenario), { 'content-type': 'application/json', 'retry-after': '0' });
    response.end(JSON.stringify({ error: state }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'synthetic-request' });
  if (scenario === 'abort-body' || scenario === 'timeout-body') {
    response.write('{"model":"jev-1.13.0","answers":');
    response.flushHeaders();
    return;
  }
  response.end(JSON.stringify({
    model: 'jev-1.13.0',
    answers: { q_red: { type: 'noul', noul: 0.1 }, q_blue: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 24, output_tokens: 0 },
  }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = 'http://127.0.0.1:' + server.address().port;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(url, endpoint + '/v1/systemone', 'only this loopback endpoint is authorized');
  const response = await nativeFetch(url, { ...init, redirect: 'error' });
  headersReceived = true;
  if (scenario === 'abort-body') controller.abort();
  return response;
};
if (scenario === 'pre-abort') controller.abort();
const payload = {
  model: 'jev-1.13.0', state,
  questions: { q_blue: noul('Synthetic blue?'), q_red: noul('Synthetic red?') },
};
let outcome;
try {
  let data;
  if (transport === 'sdk') {
    const client = new TypeSafeClient({
      apiKey: key, baseURL: endpoint, defaultModel: 'jev-1.13.0', retry: { maxRetries: 0 },
      logLevel: 'off', timeout: 200,
    });
    data = await client.systemOne(payload, { signal: controller.signal });
  } else {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(200)]);
    const response = await fetch(endpoint + '/v1/systemone', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal,
    });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error('http_failure'), { status: response.status });
    data = JSON.parse(text);
  }
  assert.equal(data.model, 'jev-1.13.0');
  assert.equal(data.answers.q_blue.noul, 0.9);
  assert.equal(data.answers.q_red.noul, 0.1);
  assert.deepEqual(data.usage, { input_tokens: 24, output_tokens: 0 });
  outcome = 'success';
} catch (error) {
  outcome = scenario === 'healthy' ? 'unexpected_failure' : 'handled_failure';
  if (error?.name === 'AssertionError') throw error;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
assert.equal(dispatches, scenario === 'pre-abort' ? 0 : 1, 'retries must be disabled');
if (dispatches) assert.equal(contractObserved, true);
if (scenario.endsWith('-body')) assert.equal(headersReceived, true);
assert.equal(outcome, scenario === 'healthy' ? 'success' : 'handled_failure');
process.stdout.write(JSON.stringify({ scenario, transport, sdk: VERSION, node: process.version, dispatches, headersReceived, outcome }) + '\n');
