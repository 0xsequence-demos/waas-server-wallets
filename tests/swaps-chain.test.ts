import { expect, it, vi } from 'vitest';
import { toEventSelector, encodeFunctionData, erc20Abi } from 'viem';
import { EvmChainReader, TrailsClient } from '@polygonlabs/oms-server-wallet-sdk/trails';
import { owner, token, intentId, recoveryFixture, word } from './fixtures/trails.js';
import { swapHarness, executeData } from './swap-harness.js';

function rpc(result: unknown, chain = '0x89') {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(url, init));
    return Response.json([
      { jsonrpc: '2.0', id: 2, result },
      { jsonrpc: '2.0', id: 1, result: chain },
    ]);
  });
  return { client: new EvmChainReader({ 137: 'https://rpc.example' }, fetcher), fetcher, requests };
}
it('reads balances losslessly and verifies chain identity on every RPC', async () => {
  const large = (2n ** 200n).toString(16);
  const r = rpc(`0x${large}`);
  expect(await r.client.balance(137, owner, 'native')).toBe((2n ** 200n).toString());
  expect(await r.client.balance(137, owner, token)).toBe((2n ** 200n).toString());
  const body = (await r.requests[1].json()) as { method: string }[];
  expect(body[0].method).toBe('eth_chainId');
  expect(body[1]).toMatchObject({
    method: 'eth_call',
    params: [
      {
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
      },
      'latest',
    ],
  });
  expect(r.requests[0].redirect).toBe('manual');
  await expect(rpc('0x0', '0x1').client.balance(137, owner, 'native')).rejects.toMatchObject({
    code: 'CHAIN_READ_FAILED',
  });
});
it('reads deployment code, pending receipts and ERC20 transfer evidence', async () => {
  expect(await rpc('0x6000').client.code(137, owner)).toBe('0x6000');
  expect(await rpc(null).client.receipt(137, intentId)).toBeNull();
  const receipt = {
    transactionHash: intentId,
    status: '0x1',
    blockNumber: '0x123',
    logs: [
      {
        address: token,
        topics: [
          toEventSelector('Transfer(address,address,uint256)'),
          `0x${word(owner)}`,
          `0x${word(token)}`,
        ],
        data: `0x${word(1000n)}`,
      },
    ],
  };
  expect(await rpc(receipt).client.receipt(137, intentId)).toMatchObject({
    status: 'success',
    blockNumber: '291',
    transfers: [{ asset: token, from: owner, to: token, amount: '1000' }],
  });
  await expect(
    rpc({ ...receipt, transactionHash: `0x${'12'.repeat(32)}` }).client.receipt(137, intentId),
  ).rejects.toMatchObject({ code: 'CHAIN_READ_FAILED' });
});
it('rejects malformed RPC replies, credentials in URLs and redirects without disclosing upstream bodies', async () => {
  const fail = async (_url: RequestInfo | URL) => Response.redirect('https://attacker.example');
  await expect(
    new EvmChainReader({ 137: 'http://localhost:9999' }, fail).balance(137, owner, 'native'),
  ).rejects.toMatchObject({ code: 'RPC_CONFIGURATION' });
  await expect(
    new EvmChainReader({ 137: 'https://user:password@rpc.example' }, fail).balance(
      137,
      owner,
      'native',
    ),
  ).rejects.toMatchObject({ code: 'RPC_CONFIGURATION' });
  await expect(
    new EvmChainReader({ 137: 'https://rpc.example' }, fail).balance(137, owner, 'native'),
  ).rejects.toMatchObject({ code: 'CHAIN_READ_FAILED' });
  await expect(rpc('not-a-quantity').client.balance(137, owner, 'native')).rejects.toMatchObject({
    code: 'CHAIN_READ_FAILED',
  });
  await expect(
    new EvmChainReader({ 137: 'https://rpc.example' }, async () =>
      Response.json({ error: 'secret upstream error' }),
    ).balance(137, owner, 'native'),
  ).rejects.not.toThrow('secret');
});
it('uses exact API mutation contracts with no commit and keeps recovery payload/signature intact', async () => {
  const h = await swapHarness();
  const prepared = h.recovery;
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const client = new TrailsClient({
    apiKey: 'trails-only-key',
    fetch: async (url, init) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(init?.body));
      calls.push({ method, body });
      if (method === 'GetIntentReceipt') return Response.json({ intentReceipt: h.receipt });
      if (method === 'BuildIntentRecoveryTransaction')
        return Response.json({
          to: prepared.intentAddress,
          data: executeData(prepared.payload.encoded),
          value: '0',
          chainId: prepared.chainId,
          intentAddress: prepared.intentAddress,
          requiresDeploy: false,
          payloadHash: prepared.payloadHash,
        });
      return Response.json({ intentId, intentStatus: 'EXECUTING' });
    },
  });
  await client.executeIntent(intentId);
  await client.getIntentReceipt(intentId);
  await client.retryIntent(intentId, intentId);
  await client.buildIntentRecoveryTransaction(
    recoveryFixture() as typeof prepared,
    '0x1234',
    owner,
  );
  expect(calls.map((c) => c.method)).toEqual([
    'ExecuteIntent',
    'GetIntentReceipt',
    'RetryIntent',
    'BuildIntentRecoveryTransaction',
  ]);
  expect(calls[0].body).toEqual({ intentId });
  expect(calls[2].body).toEqual({ intentId, depositTransactionHash: intentId });
  expect(calls[3].body).toMatchObject({
    refundToAddress: owner,
    signature: '0x1234',
    payload: prepared.payload,
  });
});
