/** Minimal output seam: tests capture the CLI without spawning a child process. */
export type CliIo = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};
