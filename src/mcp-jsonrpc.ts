/** JSON-RPC 2.0 request validation for the stdio MCP transport. */
export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** A framed line is a request, an error to answer, or something to ignore silently. */
export type ParsedLine =
  | { readonly kind: 'request'; readonly request: JsonRpcRequest }
  | { readonly kind: 'invalid'; readonly id: JsonRpcId | null; readonly code: number; readonly message: string }
  | { readonly kind: 'ignored' };

const invalid = (id: JsonRpcId | null, code: number, message: string): ParsedLine => ({
  kind: 'invalid', id, code, message,
});

export function parseRequest(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: 'ignored' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return invalid(null, PARSE_ERROR, 'invalid JSON message');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid(null, INVALID_REQUEST, 'not a JSON-RPC 2.0 message');
  }
  const record = parsed as Record<string, unknown>;
  const id = record['id'];
  const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  if (record['jsonrpc'] !== '2.0' || typeof record['method'] !== 'string'
    || (Object.hasOwn(record, 'id') && !validId)) {
    return invalid(validId ? id : null, INVALID_REQUEST, 'invalid JSON-RPC request');
  }
  const params = record['params'];
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return validId ? invalid(id, INVALID_PARAMS, 'expected object parameters') : { kind: 'ignored' };
  }
  return { kind: 'request', request: parsed as JsonRpcRequest };
}
