/**
 * Offline preload for the CLI child processes (review nit N2).
 *
 * tests/offline-guard.test.ts patches the network entry points in-process, which cannot
 * reach a spawned CLI. tests/helpers/cli-runner.ts therefore adds
 * `--import tests/helpers/offline-preload.ts` to NODE_OPTIONS, so the real entry point
 * runs with the same guard: any provider call made by a child process fails loudly
 * instead of silently reaching the network.
 */
import { createRequire } from 'node:module';

function blockedCall(label: string): () => never {
  return (): never => {
    throw new Error(`offline guard blocked a ${label} call`);
  };
}

function arm(target: object, key: string, label: string): void {
  const armed = Reflect.set(target, key, blockedCall(label));
  if (!armed) {
    throw new Error(`offline guard could not arm ${label}`);
  }
}

const nodeRequire = createRequire(import.meta.url);
const net = nodeRequire('node:net') as typeof import('node:net');
const http = nodeRequire('node:http') as typeof import('node:http');
const https = nodeRequire('node:https') as typeof import('node:https');
const dns = nodeRequire('node:dns') as typeof import('node:dns');

arm(globalThis, 'fetch', 'fetch');
arm(net, 'connect', 'net.connect');
arm(net, 'createConnection', 'net.createConnection');
arm(net.Socket.prototype as unknown as object, 'connect', 'net.Socket#connect');
arm(http, 'request', 'http.request');
arm(http, 'get', 'http.get');
arm(https, 'request', 'https.request');
arm(https, 'get', 'https.get');
arm(dns, 'lookup', 'dns.lookup');
arm(dns.promises as unknown as object, 'lookup', 'dns.promises.lookup');
