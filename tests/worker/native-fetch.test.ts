import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EvmChainReader, TrailsClient } from '@polygonlabs/oms-server-wallet-sdk/trails';
import { IndexerClient } from '../../packages/server-wallet-sdk/src/indexer.js';
import { WaasTransport } from '../../packages/server-wallet-sdk/src/transport.js';
import { contracts, owner } from '../fixtures/trails.js';

beforeEach(() => {
  // Probe workerd's real native function with the caller's receiver and a data
  // URL, then supply fixture responses. This preserves its receiver checks
  // without external I/O; replacing fetch with an arrow function would hide them.
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    new Proxy(nativeFetch, {
      async apply(target, receiver, [input]) {
        const path = new URL(String(input)).pathname;
        let response: unknown;
        if (path.endsWith('/GetSupportedIntentProtocols')) response = { versions: ['v1.5'] };
        else if (path.endsWith('/GetProtocolContracts')) response = { TrailsContracts: contracts };
        else if (path === '/rpc')
          response = [
            { jsonrpc: '2.0', id: 1, result: '0x89' },
            { jsonrpc: '2.0', id: 2, result: '0x6000' },
          ];
        else if (path.includes('GetTokenBalances'))
          response = {
            nativeBalances: [137, 42161, 8453, 56, 1].map((chainId) => ({
              chainId,
              results: [{ chainId, accountAddress: owner, balance: '0' }],
            })),
            balances: [],
          };
        else if (path === '/v1/WaasPublic/Status') response = { status: true };
        else throw new Error(`Unexpected fixture endpoint: ${path}`);
        const probe: Response = await Reflect.apply(target, receiver, ['data:text/plain,ok']);
        await probe.body?.cancel();
        return Response.json(response);
      },
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it('discovers Trails with the default native Workers fetch', async () => {
  await expect(new TrailsClient({ apiKey: 'fixture-key' }).readiness()).resolves.toEqual({
    TrailsContracts: contracts,
  });
});

it('reads chain state with the default native Workers fetch', async () => {
  await expect(
    new EvmChainReader({ 137: 'https://rpc.example/rpc' }).code(137, owner),
  ).resolves.toBe('0x6000');
});

it('reads indexer balances with the default native Workers fetch', async () => {
  const result = await new IndexerClient('pk_dev_live_test_key').getBalances(owner);
  expect(result.errors).toEqual([]);
  expect(result.items).toHaveLength(5);
  expect(result.items.every((item) => item.balance === '0')).toBe(true);
});

it('reaches mandatory attestation verification with the default native Workers fetch', async () => {
  await expect(
    new WaasTransport('pk_dev_live_test_key', ['0'.repeat(96)]).request('Status', {}),
  ).rejects.toMatchObject({ code: 'ATTESTATION_FAILED' });
});
