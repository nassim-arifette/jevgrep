/**
 * Newline-delimited framing for the stdio MCP transport.
 *
 * A line is bounded before it reaches `JSON.parse()`, including a line that never
 * ends: past the limit the partial line is dropped and the rest of it is skipped up
 * to the next newline.
 */
export type LineFramerOptions = {
  readonly maxLength: number;
  readonly onLine: (line: string) => void;
  readonly onOversized: () => void;
  /** Checked between lines, so a stopped server handles nothing more from a chunk. */
  readonly stopped: () => boolean;
};

export type LineFramer = {
  /** Feed one decoded chunk; complete lines go to `onLine`, oversized ones to `onOversized`. */
  push(chunk: string): void;
  /** The unterminated remainder at end of input, or null when it is empty or was discarded. */
  flush(): string | null;
};

export function createLineFramer(options: LineFramerOptions): LineFramer {
  let buffer = '';
  let discarding = false;
  return {
    push(chunk) {
      let rest = chunk;
      if (discarding) {
        const end = rest.indexOf('\n');
        if (end === -1) return;
        discarding = false;
        rest = rest.slice(end + 1);
      }
      buffer += rest;
      let newline = buffer.indexOf('\n');
      while (newline !== -1 && !options.stopped()) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > options.maxLength) options.onOversized();
        else options.onLine(line);
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > options.maxLength) {
        buffer = '';
        discarding = true;
        options.onOversized();
      }
    },
    flush() {
      if (discarding || buffer.trim().length === 0) return null;
      const rest = buffer;
      buffer = '';
      return rest;
    },
  };
}
