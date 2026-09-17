import { z } from 'zod';
import { verifyAttestationDocument } from './attestation.js';
import { base64EncodeBytes } from './encoding.js';
import { environmentFromKey } from './environment.js';
import { UpstreamError, WalletError } from './errors.js';
import { signatureHeader, type Credential } from './protocol.js';

export interface RpcTransport {
  request(method: string, body: Record<string, unknown>, credential?: Credential): Promise<unknown>;
}
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

/** Every WaaS response is verified. There is deliberately no skip-attestation switch. */
export class WaasTransport implements RpcTransport {
  private readonly environment;
  private readonly pcrs: Set<string>;
  constructor(
    private readonly key: string,
    trustedPcr0s: readonly string[],
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.environment = environmentFromKey(key);
    this.pcrs = new Set(trustedPcr0s.map((v) => v.trim().toLowerCase().replace(/^0x/, '')));
    if (!this.pcrs.size || [...this.pcrs].some((v) => !/^[0-9a-f]{96}$/.test(v)))
      throw new WalletError('CONFIGURATION', 'Configure approved enclave PCR0 measurements.', 503);
    if (this.environment.stage === 'production' && this.pcrs.has('0'.repeat(96)))
      throw new WalletError(
        'CONFIGURATION',
        'Debug enclaves are not permitted in production.',
        503,
      );
  }
  async request(
    method: string,
    params: Record<string, unknown>,
    credential?: Credential,
  ): Promise<unknown> {
    if (!/^[A-Za-z]+$/.test(method)) throw new WalletError('INVALID_METHOD', 'Invalid RPC method.');
    const path = `/v1/${credential ? 'Waas' : 'WaasPublic'}/${method}`;
    const body = JSON.stringify(params);
    const nonce = base64EncodeBytes(crypto.getRandomValues(new Uint8Array(18)));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Api-Key': this.key,
      'X-Attestation-Nonce': nonce,
    };
    if (credential)
      headers['OMS-Wallet-Signature'] = await signatureHeader(
        credential,
        path,
        this.environment.projectId,
        body,
      );
    const response = await this.fetcher(this.environment.origin + path, {
      method: 'POST',
      body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400)
      throw new WalletError('UPSTREAM_REDIRECT', 'WaaS redirects are not permitted.', 502);
    const responseBody = await boundedText(response);
    try {
      const encodedDocument = response.headers.get('X-Attestation-Document');
      if (!encodedDocument || encodedDocument.length > 64_000)
        throw new Error('Missing or oversized attestation');
      await verifyAttestationDocument({
        encodedDocument,
        method: 'POST',
        path,
        requestBody: body,
        responseBody,
        nonce,
        trustedPcr0s: this.pcrs,
      });
    } catch {
      throw new WalletError(
        'ATTESTATION_FAILED',
        'WaaS response could not be verified against the configured enclave trust policy.',
        502,
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(responseBody);
    } catch {
      throw new WalletError('INVALID_RESPONSE', 'WaaS returned invalid JSON.', 502);
    }
    if (!response.ok) {
      const error = z.object({ code: z.number() }).safeParse(result);
      throw new UpstreamError(error.success ? error.data.code : response.status, method);
    }
    return result;
  }
}
