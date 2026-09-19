/**
 * Give the emitted CLI the executable bit on POSIX systems.
 *
 * `tsc` writes dist/cli.js with mode 0644, so `./dist/cli.js` fails with EACCES on Linux
 * and macOS after a bare `npm run build`, even though `npm link` and `npm exec` set the
 * bit themselves (review nit N7). Windows has no executable bit; the call is a no-op there.
 */
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const entry = join(fileURLToPath(new URL('..', import.meta.url)), 'dist', 'cli.js');

if (process.platform !== 'win32') {
  chmodSync(entry, 0o755);
}
