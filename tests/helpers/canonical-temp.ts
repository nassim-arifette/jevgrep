/**
 * The source authorization policy refuses symlinked ancestors. macOS exposes its
 * temporary directory through /var -> /private/var, so fixtures must start from the
 * canonical directory just as production configuration discovery does. Preload this
 * before test imports; subprocesses inherit the same literal, authorized path.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

if (process.platform !== 'win32') process.env['TMPDIR'] = realpathSync.native(tmpdir());
