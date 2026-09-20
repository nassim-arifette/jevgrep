/** Shared bounded HTTP policy for both provider transports. */
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1_024 * 1_024;

export class ProviderBodyLimitError extends Error {
  override readonly name = 'ProviderBodyLimitError';
  constructor() { super('provider response exceeds the local byte limit'); }
}

export const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'manual' });
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const cancel = (): void => { void response.body?.cancel().catch(() => undefined); };
  // Error classification needs the status and Retry-After, never a provider body.
  // Refuse that body immediately, including malformed, oversized or stalled data.
  if (!response.ok) {
    cancel();
    const headers = new Headers(response.headers);
    headers.delete('content-length'); headers.delete('content-encoding');
    return new Response(response.status === 304 ? null : '{}', { status: response.status, headers });
  }
  if (Number(response.headers.get('content-length')) > MAX_PROVIDER_RESPONSE_BYTES) {
    cancel(); throw new ProviderBodyLimitError();
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) { abort(); throw new ProviderBodyLimitError(); }
      chunks.push(part.value);
    }
  } catch (cause) { abort(); throw cause; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  // Reject invalid UTF-8 instead of silently manufacturing replacement characters.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return new Response([204, 205, 304].includes(response.status) ? null : text, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
};
