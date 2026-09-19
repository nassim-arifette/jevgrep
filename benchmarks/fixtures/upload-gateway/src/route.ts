import { acceptUpload } from './upload';
import type { UploadPolicy, UploadPorts } from './upload';

export async function postAttachment(
  request: { readonly body: Uint8Array; readonly mediaType: string },
  policy: UploadPolicy,
  ports: UploadPorts,
): Promise<{ location: string }> {
  const location = await acceptUpload(request.body, request.mediaType, policy, ports);
  return { location };
}
