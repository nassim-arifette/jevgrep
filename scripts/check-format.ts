/**
 * Dependency-free check of the `.editorconfig` rules on every tracked text file:
 * valid UTF-8, LF line endings, a final newline, no trailing whitespace (outside
 * Markdown, where two trailing spaces are a line break) and no tab indentation.
 *
 * Binary assets and vendored minified code are skipped. Exit code 1 lists each
 * offending file with its first offending line, so `npm run verify` and CI fail.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.mp4', '.ttf', '.woff', '.woff2', '.zip', '.wasm']);
const VENDORED = /(^|\/)[^/]+\.min\.js$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

export type FormatProblem = { readonly path: string; readonly line: number | null; readonly rule: string };

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Whether a tracked path is a text file this check applies to. */
export function isCheckedPath(path: string): boolean {
  return !BINARY_EXTENSIONS.has(extensionOf(path)) && !VENDORED.test(path);
}

/** Every rule a file breaks, each with the first line that breaks it. */
export function formatProblems(path: string, bytes: Uint8Array): FormatProblem[] {
  if (bytes.length === 0) return [];
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return [{ path, line: null, rule: 'not valid UTF-8' }];
  }
  const problems: FormatProblem[] = [];
  const lines = text.split('\n');
  const first = (rule: string, broken: (line: string) => boolean): void => {
    const index = lines.findIndex(broken);
    if (index >= 0) problems.push({ path, line: index + 1, rule });
  };
  first('CRLF line ending', (line) => line.endsWith('\r'));
  if (!text.endsWith('\n')) problems.push({ path, line: lines.length, rule: 'missing final newline' });
  if (extensionOf(path) !== '.md') first('trailing whitespace', (line) => /[ \t]+\r?$/.test(line));
  first('tab indentation', (line) => line.startsWith('\t'));
  return problems;
}

function main(): number {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const checked = tracked.filter(isCheckedPath);
  const problems = checked.flatMap((path) => formatProblems(path, readFileSync(join(root, path))));
  for (const problem of problems) {
    console.error(`${problem.path}${problem.line === null ? '' : `:${String(problem.line)}`}: ${problem.rule}`);
  }
  if (problems.length > 0) {
    console.error(`format: ${String(problems.length)} problem(s); see .editorconfig`);
    return 1;
  }
  console.log(`format: ${String(checked.length)} tracked text files checked, no problems`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
