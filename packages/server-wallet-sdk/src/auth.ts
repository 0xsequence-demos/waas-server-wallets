import { z } from 'zod';
import { environmentFromAppId } from './environment.js';
import { WalletError } from './errors.js';
import { boundedText } from './http.js';

export interface SecretCredentials {
  appId: string;
  apiSecret: string;
  /** Expected project, also used to scope persisted wallet credentials. */
  projectId: string;
}

const tokenResponse = z.object({
  accessToken: z.string().min(1).max(8192),
  tokenType: z.literal('bearer'),
  expiresIn: z.number().int().positive(),
  expiresAt: z.iso.datetime({ offset: true }),
  projectId: z.string(),
  projectMode: z.enum(['sandbox', 'live']),
});

/** Exchanges secret credentials for an OMS project JWT and shares concurrent refreshes. */
export class OmsAuth {
  readonly environment;
  readonly projectId: string;
  #credentials: SecretCredentials;
  #token?: { value: string; refreshAt: number };
  #pending?: Promise<string>;

  constructor(
    credentials: SecretCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.environment = environmentFromAppId(credentials.appId);
    if (
      !credentials.apiSecret ||
      credentials.apiSecret.length > 64 ||
      !/^prj_[0-7][0-9a-hjkmnp-tv-z]{12}$/.test(credentials.projectId)
    )
      throw new WalletError('CONFIGURATION', 'Configure the OMS API secret and project ID.', 503);
    this.#credentials = { ...credentials };
    this.projectId = credentials.projectId;
  }

  async accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#token.refreshAt) return this.#token.value;
    if (!this.#pending) {
      this.#pending = this.exchange().finally(() => {
        this.#pending = undefined;
      });
    }
    return this.#pending;
  }

  private async exchange(): Promise<string> {
    const startedAt = Date.now();
    const fetcher = this.fetcher;
    const response = await fetcher(`${this.environment.origin}/v0.13/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: this.#credentials.appId,
        apiSecret: this.#credentials.apiSecret,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new WalletError(
        'UPSTREAM_REDIRECT',
        'OMS authentication redirects are not permitted.',
        502,
      );
    }
    const raw = await boundedText(response, 16_384);
    if (!response.ok)
      throw new WalletError('OMS_AUTH_FAILED', 'OMS secret credential exchange failed.', 502);
    let parsed: z.infer<typeof tokenResponse>;
    try {
      parsed = tokenResponse.parse(JSON.parse(raw));
    } catch {
      throw new WalletError('INVALID_RESPONSE', 'OMS returned an invalid token response.', 502);
    }
    const mode = this.environment.mode === 'sdbx' ? 'sandbox' : 'live';
    if (parsed.projectId !== this.projectId || parsed.projectMode !== mode)
      throw new WalletError(
        'OMS_SCOPE_MISMATCH',
        'OMS credentials do not match the configured project and mode.',
        502,
      );
    const expiresAt = Math.min(Date.parse(parsed.expiresAt), startedAt + parsed.expiresIn * 1000);
    if (expiresAt <= Date.now())
      throw new WalletError('INVALID_RESPONSE', 'OMS returned an expired token.', 502);
    this.#token = { value: parsed.accessToken, refreshAt: expiresAt - 30_000 };
    return parsed.accessToken;
  }
}
