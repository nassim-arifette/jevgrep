export type Verdict = 'clean' | 'infected' | 'unavailable';

export interface UploadPorts {
  quarantine(bytes: Uint8Array): Promise<string>;
  scan(key: string): Promise<Verdict>;
  publish(key: string): Promise<string>;
  discard(key: string): Promise<void>;
}

export type UploadPolicy = { readonly maxBytes: number; readonly mediaTypes: readonly string[] };

export async function acceptUpload(
  bytes: Uint8Array,
  mediaType: string,
  policy: UploadPolicy,
  ports: UploadPorts,
): Promise<string> {
  if (bytes.byteLength > policy.maxBytes) throw new Error('upload_too_large');
  if (!policy.mediaTypes.includes(mediaType)) throw new Error('media_type_rejected');
  const key = await ports.quarantine(bytes);
  let published = false;
  try {
    const verdict = await ports.scan(key);
    if (verdict !== 'clean') throw new Error('upload_not_clean');
    const url = await ports.publish(key);
    published = true;
    return url;
  } finally {
    if (!published) await ports.discard(key);
  }
}
