import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CHAINS, SerialExecutor, WaasTransport } from '@polygonlabs/oms-server-wallet-sdk';
import {
  EvmChainReader,
  TrailsClient,
  tokenAddress,
  type SwapView,
  type TrailsIntent,
} from '@polygonlabs/oms-server-wallet-sdk/trails';
import { createApp } from '../apps/server/app.js';
import { configFrom, scopeFor, readiness } from '../apps/server/config.js';
import { Repository, SqlStateStore, type WalletRow } from '../apps/server/database.js';
import { processCommand, type Command } from '../apps/server/service.js';
import { SqlSwapStore } from '../apps/server/swaps-store.js';
import { SWAP_ASSETS, rpcUrls, swapConfiguration } from '../apps/server/swaps-config.js';
import { FakeWaas, testDatabase } from './helpers.js';
import { quoteFixture, contracts } from './fixtures/trails.js';

const origin = 'https://dashboard.example';
let database: ReturnType<typeof testDatabase>;
let request: (path: string, body?: unknown, requestOrigin?: string) => Promise<Response>;
let walletId: string;
let rawApp: ReturnType<typeof createApp>;
let repo: Repository;
let dispatch: (row: WalletRow, command: Command) => ReturnType<typeof processCommand>;
let remote: FakeWaas;
let intent: TrailsIntent;
let body: {
  id: string;
  originChainId: number;
  originAsset: string;
  destinationChainId: number;
  destinationAsset: string;
  amount: string;
};
beforeEach(async () => {
  database = testDatabase();
  remote = new FakeWaas();
  const config = configFrom({
    ADMIN_PASSWORD: 'test-only-password',
    SESSION_SECRET: 's'.repeat(40),
    ENCRYPTION_KEY: btoa('k'.repeat(32)),
    OIDC_PRIVATE_JWK: '{}',
    OIDC_ISSUER: 'https://issuer.example',
    OIDC_AUDIENCE: 'aud',
    OMS_PUBLISHABLE_KEY: 'pk_dev_live_test_key',
    TRUSTED_PCR0S: '0'.repeat(96),
    APP_ORIGIN: origin,
    TRAILS_API_KEY: 'separate-trails-secret',
    SWAPS_ENABLED: 'true',
  });
  // Existing SDK auth uses the token provider. Supply a valid signer as in the regular API suite.
  const { generateKeyPair, exportJWK } = await import('jose');
  const keys = await generateKeyPair('ES256', { extractable: true });
  config.OIDC_PRIVATE_JWK = JSON.stringify(await exportJWK(keys.privateKey));
  vi.spyOn(WaasTransport.prototype, 'request').mockImplementation((...args) =>
    remote.request(...args),
  );
  vi.spyOn(TrailsClient.prototype, 'readiness').mockResolvedValue({ TrailsContracts: contracts });
  vi.spyOn(TrailsClient.prototype, 'getChains').mockResolvedValue({
    chains: CHAINS.map((c) => ({
      id: c.id,
      name: c.name,
      nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 },
    })),
  });
  vi.spyOn(TrailsClient.prototype, 'getTokenList').mockResolvedValue({
    tokens: SWAP_ASSETS.map((a) => ({
      chainId: a.chainId,
      address: tokenAddress(a.asset),
      name: a.name,
      symbol: a.symbol,
      decimals: a.decimals,
    })),
  });
  const fixture = quoteFixture(true);
  const destination = SWAP_ASSETS.find((a) => a.chainId === 8453 && a.symbol === 'USDC')!.asset;
  body = { id: 'api-swap-0001', ...fixture.input, destinationAsset: destination };
  intent = {
    ...fixture.intent,
    destinationTokenAddress: tokenAddress(destination),
    quoteRequest: { ...fixture.intent.quoteRequest, destinationTokenAddress: destination },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  } as TrailsIntent;
  vi.spyOn(TrailsClient.prototype, 'quoteIntent').mockImplementation(async () => ({ intent }));
  vi.spyOn(EvmChainReader.prototype, 'balance').mockResolvedValue('100000000000000000000');
  repo = new Repository(database.db, scopeFor(config));
  const locks = new Map<string, { credentials: SerialExecutor; workflow: SerialExecutor }>();
  dispatch = async (row, command) => {
    let lock = locks.get(row.id);
    if (!lock) {
      lock = { credentials: new SerialExecutor(), workflow: new SerialExecutor() };
      locks.set(row.id, lock);
    }
    const store = new SqlSwapStore(
      database.db,
      `${repo.scope}:${row.identifier}`,
      row.id,
      row.identifier,
      config.ENCRYPTION_KEY,
    );
    const result = await processCommand(
      config,
      row.identifier,
      new SqlStateStore(database.db, row.id),
      lock.credentials,
      command,
      { store, executor: lock.workflow, legacyOperationIds: () => repo.operationIds(row.id) },
    );
    await store.flush(repo);
    return result;
  };
  rawApp = createApp({ config, repo, dispatch });
  const login = await rawApp.request('/api/login', {
    method: 'POST',
    headers: { Origin: origin },
    body: JSON.stringify({ password: 'test-only-password' }),
  });
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  request = async (path, payload, requestOrigin = origin) =>
    rawApp.request(`/api${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  const created = await request('/wallets', { identifier: 'customer-1', name: 'Treasury' });
  walletId = (await data(created)).id;
});
afterEach(() => {
  database.sqlite.close();
  vi.restoreAllMocks();
});
async function data(response: Response) {
  return (await response.json()) as {
    id: string;
    swap: SwapView;
    swaps: SwapView[];
    error: string;
  };
}
async function quote() {
  const response = await request(`/wallets/${walletId}/swaps`, body);
  expect(response.status).toBe(200);
  return (await data(response)).swap as SwapView;
}
it('serves sanitized readiness and authoritative quote/confirmation/history across persisted host instances', async () => {
  const config = await request('/swaps/config');
  expect(config.status).toBe(200);
  const text = await config.text();
  expect(text).not.toContain('separate-trails-secret');
  expect(JSON.parse(text)).toMatchObject({ enabled: true, ready: true });
  const swap = await quote();
  expect(swap.quote.revision).toHaveLength(43);
  const confirmed = await request(`/wallets/${walletId}/swaps/${swap.id}/confirm`, {
    revision: swap.quote.revision,
  });
  expect(confirmed.status).toBe(202);
  expect((await data(confirmed)).swap.phase).toBe('preparing');
  const history = await request(`/wallets/${walletId}/swaps`);
  expect((await data(history)).swaps).toHaveLength(1);
  const detail = await request(`/wallets/${walletId}/swaps/${swap.id}`);
  const projection = await detail.text();
  expect(projection).not.toContain('payload');
  expect(projection).not.toContain('signature');
  expect(projection).not.toContain('quoteRequest');
  const row = (await repo.get(walletId))!;
  await dispatch(row, { kind: 'swap-tick' });
  expect(remote.calls.filter((c) => c.method === 'PrepareEthereumTransaction')).toHaveLength(1);
  expect(remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(0);
  const repeat = await request(`/wallets/${walletId}/swaps/${swap.id}/confirm`, {
    revision: swap.quote.revision,
  });
  expect(repeat.status).toBe(202);
});
it('rejects forged recipients, arbitrary assets, stale reviews, reserved child IDs and foreign origins', async () => {
  const endpoint = `/wallets/${walletId}/swaps`;
  expect((await request(endpoint, { ...body, owner: '0x123' })).status).toBe(400);
  expect(
    (
      await request(endpoint, {
        ...body,
        destinationAsset: '0x9999999999999999999999999999999999999999',
      })
    ).status,
  ).toBe(400);
  expect((await request(endpoint, body, 'https://attacker.example')).status).toBe(403);
  expect(
    (await request(`/wallets/${walletId}/operations/swp_hidden_child/execute`, {})).status,
  ).toBe(400);
  expect((await request(`/wallets/${walletId}/operations/swp_hidden_child`)).status).toBe(400);
  const swap = await quote();
  expect(
    (await request(`${endpoint}/${swap.id}/confirm`, { revision: 'x'.repeat(43) })).status,
  ).toBe(409);
  expect(
    (await request(`${endpoint}/${swap.id}/confirm`, { revision: swap.quote.revision, data: '0x' }))
      .status,
  ).toBe(400);
});
it('protects all swap/recovery routes and rejects cross-wallet IDs', async () => {
  expect((await rawApp.request('/api/swaps/config')).status).toBe(401);
  const swap = await quote();
  const created = await request('/wallets', { identifier: 'customer-2', name: 'Other' });
  const other = (await data(created)).id;
  expect((await request(`/wallets/${other}/swaps/${swap.id}`)).status).toBe(404);
  expect(
    (
      await request(`/wallets/${other}/swaps/${swap.id}/recoveries`, {
        id: 'recover-0001',
        source: 'origin',
      })
    ).status,
  ).toBe(404);
});
it('uses the operation journal to block a normal transfer while swap funding is reserved', async () => {
  const swap = await quote();
  await request(`/wallets/${walletId}/swaps/${swap.id}/confirm`, { revision: swap.quote.revision });
  const transfer = await request(`/wallets/${walletId}/transfers`, {
    id: 'normal-transfer-1',
    chainId: 137,
    asset: 'native',
    to: swap.owner,
    amount: '1',
  });
  expect(transfer.status).toBe(409);
  expect((await data(transfer)).error).toBe('DEBIT_PENDING');
});
it('missing optional Trails configuration does not break core setup and validates server RPC overrides', async () => {
  const config = configFrom({ APP_ORIGIN: origin });
  const missing = readiness(config);
  expect(
    missing.some((k) => k.startsWith('TRAILS') || k === 'SWAPS_ENABLED' || k === 'EVM_RPC_URLS'),
  ).toBe(false);
  expect(await swapConfiguration(config)).toMatchObject({ enabled: false, ready: false });
  expect(Object.keys(rpcUrls(config))).toHaveLength(5);
  expect(() => rpcUrls({ ...config, EVM_RPC_URLS: '{"137":"http://localhost:1234"}' })).toThrow();
  expect(() => rpcUrls({ ...config, EVM_RPC_URLS: '{"999":"https://rpc.example"}' })).toThrow();
});
