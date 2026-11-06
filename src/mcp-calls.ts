/**
 * Admission and cancellation of MCP tool calls: one running search, one queued
 * search, and `isFull()` for the `BUSY` answer (specification section 6.3).
 * Numeric and string request ids stay distinct, including while a call is queued.
 */
import type { JsonRpcId } from './mcp-jsonrpc.ts';

export type ToolCall = {
  readonly id: JsonRpcId;
  /** Which tool runs: one question, or several sharing their preparation. */
  readonly tool: 'search' | 'search_many';
  /** The client's `_meta.progressToken`, when it asked for progress notifications. */
  readonly progressToken?: string | number;
  readonly startedAtMs: number;
  readonly controller: AbortController;
  readonly arguments: unknown;
  /** Settles the call once it ran, or was cancelled or dropped while queued. */
  readonly resolve: () => void;
};

export type CallScheduler = {
  has(id: JsonRpcId): boolean;
  isFull(): boolean;
  submit(call: ToolCall): void;
  /** Abort a call; a queued call is also removed and settled without running. */
  cancel(id: JsonRpcId): void;
  cancelAll(): void;
  /** Stop admitting: the queued call is dropped unrun and later submissions settle at once; the running call continues. */
  drain(): void;
};

const callKey = (id: JsonRpcId): string => JSON.stringify(id);

/** `run` must not reject: it reports its own failures. */
export function createCallScheduler(run: (call: ToolCall) => Promise<void>): CallScheduler {
  const active = new Map<string, ToolCall>();
  let running: ToolCall | null = null;
  let queued: ToolCall | null = null;
  let draining = false;

  const dropQueued = (): void => {
    if (queued === null) return;
    const call = queued;
    queued = null;
    active.delete(callKey(call.id));
    call.resolve();
  };

  const execute = async (call: ToolCall): Promise<void> => {
    running = call;
    try {
      await run(call);
    } finally {
      active.delete(callKey(call.id));
      running = null;
      call.resolve();
      if (queued !== null) {
        const next = queued;
        queued = null;
        void execute(next);
      }
    }
  };

  return {
    has: (id) => active.has(callKey(id)),
    isFull: () => running !== null && queued !== null,
    submit(call) {
      if (draining) { call.resolve(); return; }
      active.set(callKey(call.id), call);
      if (running === null) void execute(call);
      else queued = call;
    },
    cancel(id) {
      const call = active.get(callKey(id));
      if (call === undefined) return;
      call.controller.abort();
      if (queued === call) dropQueued();
    },
    cancelAll() {
      for (const call of active.values()) call.controller.abort();
      dropQueued();
    },
    drain() {
      draining = true;
      dropQueued();
    },
  };
}
