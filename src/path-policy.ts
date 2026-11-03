/**
 * Lexical relative-path policy shared by the public contract validators and the
 * filesystem authorization layer. It never touches the filesystem: callers decide
 * how a violation is reported, and the authorization layer adds its own on-disk
 * checks (realpath containment, links, reparse points) on top.
 */
export type RelativePathViolation = 'absolute' | 'syntax' | 'traversal' | 'trailing' | 'device';

export type RelativePathCheck =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly violation: RelativePathViolation };

// oxlint-disable-next-line no-control-regex -- control characters are rejected on purpose
const UNSUPPORTED_CHARACTERS = /[\u0000-\u001f\u007f<>:"|?*]/;
const AMBIGUOUS_TRAILING = /[. ]$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

/**
 * Check a portable relative path and return its canonical `/`-separated form, with
 * empty and `.` segments removed (`.` when nothing remains). Checks run in a fixed
 * order so the first violation reported is stable.
 */
export function checkRelativePath(input: string): RelativePathCheck {
  if (/^[\\/]/.test(input)) return { ok: false, violation: 'absolute' };
  if (UNSUPPORTED_CHARACTERS.test(input)) return { ok: false, violation: 'syntax' };
  const segments = input.replaceAll('\\', '/').split('/');
  if (segments.includes('..')) return { ok: false, violation: 'traversal' };
  const parts = segments.filter((part) => part !== '' && part !== '.');
  for (const part of parts) {
    if (AMBIGUOUS_TRAILING.test(part)) return { ok: false, violation: 'trailing' };
    if (WINDOWS_DEVICE_NAME.test(part)) return { ok: false, violation: 'device' };
  }
  return { ok: true, normalized: parts.join('/') || '.' };
}
