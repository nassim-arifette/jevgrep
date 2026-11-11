/**
 * Authorization refuses symlinked ancestors. Normalize the macOS /var temporary
 * alias before fixture imports, and isolate commands using default process.env so
 * tests can never clear an operator's cache or discover their saved configuration.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'win32') process.env['TMPDIR'] = realpathSync.native(tmpdir());

const inheritedHome = process.env['JEVGREP_TEST_STATE_HOME'];
const stateHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'jevgrep-test-process-')));
for (const [key, directory] of [['JEVGREP_CACHE_HOME', 'cache'], ['JEVGREP_CONFIG_HOME', 'configuration']] as const) {
  const current = process.env[key];
  // Child tests get their own defaults. Explicit fixture environments supplied to
  // a child remain authoritative instead of being replaced by the preload.
  if (current === undefined || inheritedHome === undefined || current === join(inheritedHome, directory)) {
    process.env[key] = join(stateHome, directory);
  }
}
process.env['JEVGREP_TEST_STATE_HOME'] = stateHome;
process.once('exit', () => { rmSync(stateHome, { recursive: true, force: true }); });
