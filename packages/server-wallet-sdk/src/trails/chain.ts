import { encodeFunctionData, erc20Abi, zeroAddress, toEventSelector } from 'viem';
import { z } from 'zod';
import { boundedText } from '../http.js';
import { canonicalJson } from '../json.js';
import { WalletError } from '../errors.js';
import { requireChain } from '../environment.js';
import { addressSchema, hashSchema } from './protocol.js';
import { tokenAddress } from './quote.js';

export interface ChainReceipt {
  hash: string;
  status: 'success' | 'reverted';
  blockNumber: string;
  transfers: { asset: string; from: string; to: string; amount: string }[];
}
export interface ChainReader {
  balance(chainId: number, owner: string, asset: string): Promise<string>;
  code(chainId: number, address: string): Promise<string>;
  receipt(chainId: number, hash: string): Promise<ChainReceipt | null>;
}
const hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const quantity = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/)
  .max(66);
const rpcReceipt = z.object({
  transactionHash: hashSchema,
  status: z.enum(['0x0', '0x1']),
  blockNumber: quantity,
  logs: z
    .array(z.object({ address: addressSchema, topics: z.array(hashSchema).max(8), data: hex }))
    .max(2048),
});
const transferTopic = toEventSelector('Transfer(address,address,uint256)');

/** Backend-configured HTTPS endpoints. Each read verifies the endpoint's chain. */
export class EvmChainReader implements ChainReader {
  constructor(
    private readonly urls: Readonly<Record<number, string>>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    requireChain(chainId);
    let url: URL;
    try {
      url = new URL(this.urls[chainId]);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    } catch {
      throw new WalletError(
        'RPC_CONFIGURATION',
        'Configure an HTTPS RPC endpoint for this chain.',
        503,
      );
    }
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 2, method, params },
    ];
    try {
      const fetcher = this.fetcher;
      const response = await fetcher(url.toString(), {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requests),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const result: unknown = JSON.parse(await boundedText(response));
      canonicalJson(result, 2_000_000);
      const rows = z
        .array(
          z.object({
            jsonrpc: z.literal('2.0'),
            id: z.number(),
            result: z.unknown(),
            error: z.unknown().optional(),
          }),
        )
        .length(2)
        .parse(result);
      const chain = rows.find((r) => r.id === 1),
        value = rows.find((r) => r.id === 2);
      if (
        !chain ||
        !value ||
        chain.error ||
        value.error ||
        BigInt(quantity.parse(chain.result)) !== BigInt(chainId)
      )
        throw new Error();
      return value.result;
    } catch {
      throw new WalletError(
        'CHAIN_READ_FAILED',
        'Could not verify current on-chain state. Try again later.',
        502,
      );
    }
  }
  async balance(chainId: number, owner: string, asset: string): Promise<string> {
    const address = addressSchema.parse(owner),
      token = tokenAddress(asset);
    const result =
      token === zeroAddress
        ? await this.rpc(chainId, 'eth_getBalance', [address, 'latest'])
        : await this.rpc(chainId, 'eth_call', [
            {
              to: token,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [address],
              }),
            },
            'latest',
          ]);
    try {
      return BigInt(quantity.parse(result)).toString();
    } catch {
      throw new WalletError('CHAIN_READ_FAILED', 'The balance response was invalid.', 502);
    }
  }
  async code(chainId: number, address: string): Promise<string> {
    return hex.parse(
      await this.rpc(chainId, 'eth_getCode', [addressSchema.parse(address), 'latest']),
    );
  }
  async receipt(chainId: number, hash: string): Promise<ChainReceipt | null> {
    const result = await this.rpc(chainId, 'eth_getTransactionReceipt', [hashSchema.parse(hash)]);
    if (result === null) return null;
    const receipt = rpcReceipt.parse(result);
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase())
      throw new WalletError('CHAIN_READ_FAILED', 'Mismatched transaction receipt.', 502);
    const transfers = receipt.logs
      .filter(
        (l) =>
          l.topics.length === 3 &&
          l.topics[0].toLowerCase() === transferTopic &&
          l.data.length === 66,
      )
      .map((l) => ({
        asset: l.address,
        from: `0x${l.topics[1].slice(-40)}`.toLowerCase(),
        to: `0x${l.topics[2].slice(-40)}`.toLowerCase(),
        amount: BigInt(l.data).toString(),
      }));
    return {
      hash,
      status: receipt.status === '0x1' ? 'success' : 'reverted',
      blockNumber: BigInt(receipt.blockNumber).toString(),
      transfers,
    };
  }
}
