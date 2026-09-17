import { describe, expect, it, vi } from 'vitest';
import { TrailsClient, TrailsError } from '@polygonlabs/oms-server-wallet-sdk/trails';
import {
  buildSwapRequest,
  tokenAddress,
  validateSwapQuote,
} from '../packages/server-wallet-sdk/src/trails/quote.js';
import { contractsSchema } from '../packages/server-wallet-sdk/src/trails/protocol.js';
import {
  contracts,
  intentId,
  now,
  owner,
  quoteFixture,
  recoveryFixture,
  token,
  zero,
} from './fixtures/trails.js';

const policy = contractsSchema.parse(contracts);
const makeClient = (body: unknown, status = 200) => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
  return {
    client: new TrailsClient({
      apiKey: 'trails-test-key',
      origin: 'https://dashboard.example',
      fetch: fetcher,
    }),
    fetcher,
  };
};

describe('Trails direct API transport', () => {
  it('uses the Trails key, explicit origin, POST and manual redirects without OMS credentials', async () => {
    const { client, fetcher } = makeClient({ chains: [] });
    await client.getChains();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://trails-api.sequence.app/rpc/Trails/GetChains');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: '{}' });
    expect(init!.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Access-Key': 'trails-test-key',
      Origin: 'https://dashboard.example',
    });
  });
  it('negotiates the v1.5 wire value and accepts its empty legacy contract fields', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ versions: ['v1', 'v1.5'] }))
      .mockResolvedValueOnce(Response.json({ TrailsContracts: contracts }));
    const client = new TrailsClient({ apiKey: 'key', fetch: fetcher });
    expect(await client.readiness()).toEqual({ TrailsContracts: contracts });
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({
      intentProtocol: 'v1.5',
    });
    await expect(makeClient({ versions: ['v1_5'] }).client.readiness()).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL',
    });
  });
  it('discovers assets/routes and validates quote, intent and recovery response envelopes', async () => {
    const { intent, request } = quoteFixture();
    const asset = { chainId: 137, address: token, name: 'Test USD', symbol: 'USD', decimals: 6 };
    const h = makeClient({ tokens: [asset] });
    expect(await h.client.getTokenList([137])).toEqual({ tokens: [asset] });
    expect(JSON.parse(h.fetcher.mock.calls[0][1]!.body as string)).toEqual({
      chainIds: [137],
      includeAllListed: true,
      includeExternal: false,
    });
    expect(await h.client.getExactInputRoutes(137, token)).toEqual({ tokens: [asset] });
    expect((await makeClient({ intent }).client.quoteIntent(request)).intent.intentId).toBe(
      intentId,
    );
    expect((await makeClient({ intent }).client.getIntent(intentId)).intent.intentId).toBe(
      intentId,
    );
    const prepared = recoveryFixture();
    expect(
      await makeClient(prepared).client.prepareIntentRecovery(
        intentId,
        prepared.intentAddress,
        owner,
      ),
    ).toEqual(prepared);
  });
  it.each([
    { baseUrl: 'http://trails.example' },
    { baseUrl: 'https://secret@trails.example' },
    { baseUrl: 'https://trails.example/path' },
    { baseUrl: 'https://trails.example/?key=secret' },
    { apiKey: '' },
    { apiKey: 'key\r\nX-Injected: secret' },
    { origin: 'https://ui.example/path' },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
  ])('rejects unsafe configuration %j', (options) => {
    expect(() => new TrailsClient({ apiKey: 'key', ...options })).toThrow(/Configure/);
  });
  it('refuses redirects without forwarding the key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.redirect('https://attacker.example', 302),
    );
    await expect(
      new TrailsClient({ apiKey: 'secret', fetch: fetcher }).getChains(),
    ).rejects.toMatchObject({ code: 'UPSTREAM_REDIRECT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([200, 403, 429, 500])(
    'sanitizes HTTP/RPC failures and never retries (%i)',
    async (status) => {
      const { client, fetcher } = makeClient(
        { code: 123, message: 'secret-token', cause: 'secret-key' },
        status,
      );
      const error = await client.getChains().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TrailsError);
      expect(error).toMatchObject({ method: 'GetChains', httpStatus: status, upstreamCode: 123 });
      expect(JSON.stringify(error)).not.toContain('secret');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds responses and rejects invalid JSON, unsafe integers and unsupported shapes', async () => {
    for (const body of [
      'x'.repeat(2_000_001),
      'not json',
      '{"chains":[],"amount":9007199254740993}',
      '{"chains":{}}',
    ]) {
      const client = new TrailsClient({ apiKey: 'key', fetch: async () => new Response(body) });
      await expect(client.getChains()).rejects.toMatchObject({
        code: body.length > 2_000_000 ? 'RESPONSE_TOO_LARGE' : 'INVALID_RESPONSE',
      });
    }
    await expect(makeClient({}).client.getChains()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    await expect(makeClient({}, 503).client.getChains()).rejects.toMatchObject({ httpStatus: 503 });
  });
  it('bounds request time, propagates caller cancellation and sanitizes fetch errors', async () => {
    const fetcher: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init!.signal!.aborted) reject(init!.signal!.reason);
        else
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
      });
    const client = new TrailsClient({ apiKey: 'key', fetch: fetcher, timeoutMs: 10 });
    await expect(client.getChains()).rejects.toMatchObject({ code: 'TRAILS_TIMEOUT' });
    await expect(client.getChains(AbortSignal.abort())).rejects.toMatchObject({
      code: 'TRAILS_ABORTED',
    });
    const unavailable = new TrailsClient({
      apiKey: 'key',
      fetch: async () => {
        throw new Error('secret');
      },
    });
    await expect(unavailable.getChains()).rejects.toMatchObject({ code: 'TRAILS_UNAVAILABLE' });
  });
});

describe('quote authorization', () => {
  it.each([false, true])('validates %s native funding and snapshots the quote', async (native) => {
    const { intent, request } = quoteFixture(native, '123456789012345678901234567890');
    const quote = await validateSwapQuote(intent, request, policy, now);
    expect(quote.funding).toEqual({
      chainId: 137,
      to: intent.originIntentAddress,
      asset: native ? 'native' : token,
      amount: request.originTokenAmount,
    });
    expect(quote.digest).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    const second = await validateSwapQuote(
      { ...intent, quoteRequest: { ...intent.quoteRequest } },
      request,
      policy,
      now,
    );
    expect(second.digest).toBe(quote.digest);
    intent.quote.toAmount = '123';
    expect(quote.intent.quote.toAmount).toBe('9900000');
  });
  it('normalizes native aliases and fixes recipient, mode, funding and 50bps defaults', () => {
    const { request } = quoteFixture(true);
    expect(tokenAddress('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe(zero);
    expect(request).toMatchObject({
      ownerAddress: owner,
      destinationToAddress: owner,
      originTokenAddress: zero,
      tradeType: 'EXACT_INPUT',
      fundMethod: 'WALLET',
      mode: 'SWAP',
      options: { intentProtocol: 'v1.5', slippageTolerance: 0.005 },
    });
  });
  it('restricts chains, host-approved assets, positive uint256 input, distinct sides and slippage', () => {
    const { input, assets } = quoteFixture();
    for (const change of [
      { amount: '0' },
      { amount: '1e18' },
      { amount: '-1' },
      { amount: (2n ** 256n).toString() },
      { originChainId: 10 },
      { originAsset: owner },
      { destinationChainId: 137, destinationAsset: token },
    ]) {
      expect(() => buildSwapRequest(owner, { ...input, ...change }, assets)).toThrow(
        /Select supported/,
      );
    }
    expect(() => buildSwapRequest(zero, input, assets)).toThrow();
    expect(() => buildSwapRequest(owner, { ...input, slippageBps: 500 as 50 }, assets)).toThrow();
    expect(() =>
      buildSwapRequest(
        owner,
        input,
        assets.map((a) => ({ ...a, decimals: -1 })),
      ),
    ).toThrow();
  });
  const mutations: [string, (intent: ReturnType<typeof quoteFixture>['intent']) => void][] = [
    [
      'owner',
      (i) => {
        i.ownerAddress = token;
      },
    ],
    [
      'recipient',
      (i) => {
        i.quoteRequest.destinationToAddress = token;
      },
    ],
    [
      'chain',
      (i) => {
        i.destinationChainId = 1;
      },
    ],
    [
      'asset',
      (i) => {
        i.originTokenAddress = owner;
      },
    ],
    [
      'deposit amount',
      (i) => {
        i.depositTransaction.amount = '1';
      },
    ],
    [
      'deposit target',
      (i) => {
        i.depositTransaction.toAddress = owner;
      },
    ],
    [
      'deposit chain',
      (i) => {
        i.depositTransaction.chainId = 1;
      },
    ],
    [
      'deposit calldata',
      (i) => {
        i.depositTransaction.data += '00';
      },
    ],
    [
      'deposit value',
      (i) => {
        i.depositTransaction.value = '1';
      },
    ],
    [
      'precondition',
      (i) => {
        i.originPrecondition.minAmount = '1';
      },
    ],
    [
      'expiry',
      (i) => {
        i.expiresAt = new Date(now + 29_999).toISOString();
      },
    ],
    [
      'slippage',
      (i) => {
        i.quote.maxSlippage = 0.01;
      },
    ],
    [
      'slippage minimum',
      (i) => {
        i.quote.toAmountMin = '1';
      },
    ],
    [
      'minimum exceeds output',
      (i) => {
        i.quote.toAmountMin = '9900001';
      },
    ],
    [
      'zero output',
      (i) => {
        i.quote.toAmount = '0';
        i.quote.toAmountMin = '0';
      },
    ],
    [
      'excess debit',
      (i) => {
        i.quote.fromAmount = '10000001';
      },
    ],
    [
      'contracts',
      (i) => {
        i.trailsContracts.trailsUtilsAddress = owner as `0x${string}`;
      },
    ],
    [
      'untrusted overrides',
      (i) => {
        i.quoteRequest.options = {
          ...(i.quoteRequest.options as object),
          trailsAddressOverrides: {},
        };
      },
    ],
    [
      'destination calls',
      (i) => {
        i.quoteRequest.destinationCallData = '0x1234';
      },
    ],
    [
      'destination approval',
      (i) => {
        i.quoteRequest.destinationApproveAddress = token;
      },
    ],
    [
      'settlement',
      (i) => {
        i.quoteRequest.settlement = {};
      },
    ],
    [
      'testnet',
      (i) => {
        i.isTestnet = true;
      },
    ],
  ];
  it.each(mutations)('rejects a changed %s before funding', async (_name, mutate) => {
    const { intent, request } = quoteFixture();
    mutate(intent);
    await expect(validateSwapQuote(intent, request, policy, now)).rejects.toMatchObject({
      code: 'INVALID_SWAP_QUOTE',
    });
  });
  it.each([
    { intentProtocol: 'v1_5' },
    { passthrough: true },
    { status: 'EXECUTING' },
    { quote: { fromAmount: 9007199254740992 } },
  ])('rejects unsupported intent shapes', async (override) => {
    const { intent, request } = quoteFixture();
    await expect(
      validateSwapQuote({ ...intent, ...override }, request, policy, now),
    ).rejects.toMatchObject({ code: 'INVALID_SWAP_QUOTE' });
  });
});
