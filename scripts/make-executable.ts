/**
 * Give the emitted CLI the executable bit on POSIX systems.
 *
 * `tsc` writes dist/cli.js with mode 0644, so `./dist/cli.js` fails with EACCES on Linux
 * and macOS after a bare `npm run build`, even though `npm link` and `npm exec` set the
 * bit themselves (review nit N7). Windows has no executable bit; the call is a no-op there.
 */
import { chmodSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = join(root, 'dist', 'cli.js');

// tsc emits only JavaScript; the vendored Tree-sitter grammars ship next to their loader.
cpSync(join(root, 'src', 'source', 'grammars'), join(root, 'dist', 'source', 'grammars'), { recursive: true });

if (process.platform !== 'win32') {
  chmodSync(entry, 0o755);
}
