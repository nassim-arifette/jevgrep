import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const preload = fileURLToPath(new URL('./helpers/canonical-temp.ts', import.meta.url));
const probe = `console.log(JSON.stringify({ home: process.env.JEVGREP_TEST_STATE_HOME,
  cache: process.env.JEVGREP_CACHE_HOME, config: process.env.JEVGREP_CONFIG_HOME }));`;

function childState(env: NodeJS.ProcessEnv): { home: string; cache: string; config: string } {
  return JSON.parse(execFileSync(process.execPath, ['--import', preload, '--input-type=module', '--eval', probe], {
    env, encoding: 'utf8',
  })) as { home: string; cache: string; config: string };
}

test('default command tests receive private per-process cache and configuration paths', () => {
  const parentHome = process.env['JEVGREP_TEST_STATE_HOME'];
  const state = childState(process.env);
  assert.notEqual(state.home, parentHome);
  assert.equal(state.cache, join(state.home, 'cache'));
  assert.equal(state.config, join(state.home, 'configuration'));
  assert.equal(existsSync(state.home), false, 'the child removes only its owned test state on exit');
  assert.ok(parentHome !== undefined && existsSync(parentHome), 'a child cannot remove the parent test state');
});

test('explicit fixture paths survive a child test preload', () => {
  const parentHome = process.env['JEVGREP_TEST_STATE_HOME'];
  assert.ok(parentHome !== undefined);
  const cache = join(parentHome, 'fixture-cache');
  const config = join(parentHome, 'fixture-config');
  const state = childState({ ...process.env, JEVGREP_CACHE_HOME: cache, JEVGREP_CONFIG_HOME: config });
  assert.equal(state.cache, cache);
  assert.equal(state.config, config);
  assert.equal(existsSync(state.home), false);
  assert.equal(existsSync(parentHome), true);
});
