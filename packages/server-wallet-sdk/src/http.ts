import { WalletError } from './errors.js';

export async function boundedText(response: Response, limit = 2_000_000): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new WalletError(
          'RESPONSE_TOO_LARGE',
          'Upstream response exceeds the allowed size.',
          502,
        );
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
