import { z } from 'zod';
import { WalletError } from '../errors.js';
import { canonicalJson } from '../json.js';
import { boundedText } from '../http.js';
import {
  addressSchema,
  chainSchema,
  chainInfoSchema,
  contractsSchema,
  hashSchema,
  intentSchema,
  tokenSchema,
  recoverySchema,
  receiptSchema,
  statusSchema,
  builtRecoverySchema,
  type PreparedRecovery,
} from './protocol.js';

export interface TrailsClientOptions {
  apiKey: string;
  baseUrl?: string;
  origin?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Structured errors intentionally exclude upstream messages, bodies and secrets. */
export class TrailsError extends WalletError {
  constructor(
    public readonly method: string,
    public readonly httpStatus: number,
    public readonly upstreamCode?: number,
  ) {
    super(
      'TRAILS_ERROR',
      `Trails ${method} failed (HTTP ${httpStatus}${upstreamCode === undefined ? '' : `, code ${upstreamCode}`}).`,
      502,
    );
    this.name = 'TrailsError';
  }
}

/** Direct API transport. No automatic mutation retries, commits, wallet signing or funding. */
export class TrailsClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  constructor(options: TrailsClientOptions) {
    try {
      const url = new URL(options.baseUrl ?? 'https://trails-api.sequence.app');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new Error();
      if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new Error();
      this.baseUrl = url.origin;
      this.timeoutMs = options.timeoutMs ?? 20_000;
      if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
        throw new Error();
      this.headers = { 'Content-Type': 'application/json', 'X-Access-Key': options.apiKey };
      if (options.origin) {
        const origin = new URL(options.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.origin)
          throw new Error();
        this.headers.Origin = origin.origin;
      }
      this.fetcher = options.fetch ?? fetch;
    } catch {
      throw new WalletError(
        'CONFIGURATION',
        'Configure a Trails key, HTTPS API origin and valid request settings.',
        503,
      );
    }
  }
  private async call<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = canonicalJson(params);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(`${this.baseUrl}/rpc/Trails/${method}`, {
        method: 'POST',
        headers: { ...this.headers },
        body,
        redirect: 'manual',
        signal: combined,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new WalletError('UPSTREAM_REDIRECT', 'Trails redirects are not permitted.', 502);
      }
      text = await boundedText(response);
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        signal?.aborted
          ? 'TRAILS_ABORTED'
          : timeout.aborted
            ? 'TRAILS_TIMEOUT'
            : 'TRAILS_UNAVAILABLE',
        'Trails request did not complete. Reconcile mutations before retrying.',
        502,
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
      canonicalJson(result, 2_000_000);
    } catch {
      throw new WalletError('INVALID_RESPONSE', 'Trails returned invalid or unsafe JSON.', 502);
    }
    const error = z
      .object({ code: z.number().int(), error: z.string().optional() })
      .safeParse(result);
    if (!response.ok || error.success)
      throw new TrailsError(method, response.status, error.success ? error.data.code : undefined);
    const parsed = schema.safeParse(result);
    if (!parsed.success)
      throw new WalletError(
        'INVALID_RESPONSE',
        `Trails ${method} returned an unsupported response.`,
        502,
      );
    return parsed.data;
  }
  async readiness(signal?: AbortSignal) {
    const { versions } = await this.call(
      'GetSupportedIntentProtocols',
      {},
      z.object({ versions: z.array(z.string()) }),
      signal,
    );
    if (!versions.includes('v1.5'))
      throw new WalletError('UNSUPPORTED_PROTOCOL', 'Trails v1.5 is required.', 503);
    return this.call(
      'GetProtocolContracts',
      { intentProtocol: 'v1.5' },
      z.object({ TrailsContracts: contractsSchema }),
      signal,
    );
  }
  getChains(signal?: AbortSignal) {
    return this.call(
      'GetChains',
      {},
      z.object({ chains: z.array(chainInfoSchema).max(500) }),
      signal,
    );
  }
  getTokenList(chainIds: number[], signal?: AbortSignal) {
    z.array(chainSchema).min(1).max(20).parse(chainIds);
    return this.call(
      'GetTokenList',
      { chainIds, includeAllListed: true, includeExternal: false },
      z.object({ tokens: z.array(tokenSchema).max(10_000) }),
      signal,
    );
  }
  getExactInputRoutes(originChainId: number, originTokenAddress: string, signal?: AbortSignal) {
    return this.call(
      'GetExactInputRoutes',
      {
        originChainId: chainSchema.parse(originChainId),
        originTokenAddress: addressSchema.parse(originTokenAddress),
      },
      z.object({ tokens: z.array(tokenSchema).max(10_000) }),
      signal,
    );
  }
  /** Request built by buildSwapRequest; validate the returned quote before using its deposit. */
  quoteIntent(request: Record<string, unknown>, signal?: AbortSignal) {
    return this.call(
      'QuoteIntent',
      request,
      z.object({ intent: intentSchema }).passthrough(),
      signal,
    );
  }
  getIntent(intentId: string, signal?: AbortSignal) {
    return this.call(
      'GetIntent',
      { intentId: hashSchema.parse(intentId) },
      z.object({ intent: intentSchema }),
      signal,
    );
  }
  executeIntent(intentId: string, signal?: AbortSignal) {
    return this.call(
      'ExecuteIntent',
      { intentId: hashSchema.parse(intentId) },
      z.object({ intentId: hashSchema, intentStatus: statusSchema }),
      signal,
    );
  }
  getIntentReceipt(intentId: string, signal?: AbortSignal) {
    return this.call(
      'GetIntentReceipt',
      { intentId: hashSchema.parse(intentId) },
      z.object({ intentReceipt: receiptSchema }),
      signal,
    );
  }
  retryIntent(intentId: string, depositTransactionHash: string, signal?: AbortSignal) {
    return this.call(
      'RetryIntent',
      {
        intentId: hashSchema.parse(intentId),
        depositTransactionHash: hashSchema.parse(depositTransactionHash),
      },
      z.object({ intentId: hashSchema, intentStatus: statusSchema }),
      signal,
    );
  }
  buildIntentRecoveryTransaction(
    prepared: PreparedRecovery,
    signature: string,
    refundToAddress: string,
    signal?: AbortSignal,
  ) {
    return this.call(
      'BuildIntentRecoveryTransaction',
      {
        intentId: hashSchema.parse(prepared.intentId),
        intentAddress: addressSchema.parse(prepared.intentAddress),
        payload: prepared.payload,
        signature: z
          .string()
          .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
          .max(131_074)
          .parse(signature),
        refundToAddress: addressSchema.parse(refundToAddress),
      },
      builtRecoverySchema,
      signal,
    );
  }
  prepareIntentRecovery(
    intentId: string,
    intentAddress: string,
    refundToAddress: string,
    signal?: AbortSignal,
  ) {
    return this.call(
      'PrepareIntentRecovery',
      {
        intentId: hashSchema.parse(intentId),
        intentAddress: addressSchema.parse(intentAddress),
        refundToAddress: addressSchema.parse(refundToAddress),
      },
      recoverySchema,
      signal,
    );
  }
}
