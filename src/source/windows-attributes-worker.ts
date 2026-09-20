import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { ATTRIBUTE_REQUEST_TIMEOUT_MS, ATTRIBUTE_STARTUP_TIMEOUT_MS } from './windows-attributes-timeouts.ts';

// Fixed program, no profiles or interpolated paths. Only status/index are returned.
// GetAttributes examines the entry itself, including any reparse tag (bit 0x400).
const PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($null -ne ($requestLine = [Console]::ReadLine())) {
  $replyCode = 1
  $failureIndex = -1
  try {
    $candidatePaths = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $requestLine
    $pathIndex = 0
    foreach ($candidatePath in $candidatePaths) {
      try {
        $entryAttributes = [System.IO.File]::GetAttributes([string]$candidatePath)
      } catch {
        $failureIndex = $pathIndex
        $baseFailure = $_.Exception.GetBaseException()
        if ($baseFailure -is [System.IO.FileNotFoundException] -or $baseFailure -is [System.IO.DirectoryNotFoundException]) {
          $replyCode = 3
        } else { $replyCode = 4 }
        break
      }
      if (([int]$entryAttributes -band 1024) -ne 0) { $replyCode = 2; $failureIndex = $pathIndex; break }
      $pathIndex += 1
    }
  } catch { $replyCode = 4 }
  [Console]::Out.WriteLine("$replyCode $failureIndex")
}
`;

if (parentPort === null) throw new Error('attribute helper requires a worker');
const port = parentPort;
const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
if (!/^[A-Za-z]:[\\/]/.test(systemRoot)) throw new Error('invalid Windows installation path');
const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROGRAM], {
  windowsHide: true, cwd: systemRoot, stdio: ['pipe', 'pipe', 'pipe'],
  env: { SystemRoot: systemRoot, WINDIR: systemRoot },
});

let pending: Int32Array | null = null;
let timer: NodeJS.Timeout | undefined;
let closed = false;
let initialized = false;
let buffer = '';

function answer(status: number, index = -1): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (pending !== null) {
    Atomics.store(pending, 1, index);
    Atomics.store(pending, 0, status);
    Atomics.notify(pending, 0);
    pending = null;
  }
}

function close(): void {
  if (closed) return;
  closed = true;
  answer(5);
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.kill();
  port.close();
}

child.on('error', close);
child.on('exit', close);
child.stdin.on('error', close);
child.stderr.resume();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  if (buffer.length > 64) { close(); return; }
  const newline = buffer.indexOf('\n');
  if (newline === -1) return;
  const line = buffer.slice(0, newline).trim();
  buffer = buffer.slice(newline + 1);
  const reply = /^([1-4]) (-1|[0-9]{1,3})$/.exec(line);
  if (pending === null || reply === null || buffer.length > 0 || Number(reply[2]) >= 512) { close(); return; }
  initialized = true;
  answer(Number(reply[1]), Number(reply[2]));
});
port.on('message', (message: { paths?: readonly string[]; state?: SharedArrayBuffer; close?: boolean }) => {
  if (message.close === true) { close(); return; }
  if (message.state === undefined) { close(); return; }
  if (pending !== null || closed) {
    const rejected = new Int32Array(message.state);
    Atomics.store(rejected, 0, 5);
    Atomics.notify(rejected, 0);
    close();
    return;
  }
  pending = new Int32Array(message.state);
  timer = setTimeout(close, initialized ? ATTRIBUTE_REQUEST_TIMEOUT_MS : ATTRIBUTE_STARTUP_TIMEOUT_MS);
  child.stdin.write(`${JSON.stringify(message.paths)}\n`);
});
port.on('close', close);
process.on('exit', () => child.kill());
