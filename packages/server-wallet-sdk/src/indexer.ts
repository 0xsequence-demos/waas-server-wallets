import { z } from 'zod';
import { getAddress } from 'viem';
import { CHAINS, environmentFromKey, requireChain } from './environment.js';
import { WalletError } from './errors.js';
import { boundedText } from './transport.js';

const quantity = z.string().regex(/^[0-9]+$/);
const rowSchema = z.object({
  chainId: z.number().int(),
  accountAddress: z.string(),
  balance: quantity.optional(),
  balanceWei: quantity.optional(),
  contractType: z.string().optional(),
  contractAddress: z.string().optional(),
  name: z.string().optional(),
  symbol: z.string().optional(),
  balanceUSD: z.string().optional(),
  contractInfo: z
    .object({
      name: z.string().optional(),
      symbol: z.string().optional(),
      decimals: z.number().int().min(0).max(255).optional(),
    })
    .optional(),
  errorReason: z.string().optional(),
});
const groupSchema = z.object({
  chainId: z.number().int(),
  errorReason: z.string().optional(),
  results: z.array(rowSchema).optional(),
});
const responseSchema = z.object({
  nativeBalances: z.array(groupSchema),
  balances: z.array(groupSchema),
  page: z
    .object({ page: z.number().int(), pageSize: z.number().int(), more: z.boolean() })
    .optional(),
});
export interface Balance {
  chainId: number;
  asset: string;
  name: string;
  symbol: string;
  balance: string;
  decimals?: number;
  balanceUSD?: string;
}
export interface Balances {
  items: Balance[];
  errors: { chainId: number; message: string }[];
  nextPage?: number;
  fetchedAt: string;
}
export class IndexerClient {
  private readonly environment;
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.environment = environmentFromKey(key);
  }
  async getBalances(address: string, page = 0): Promise<Balances> {
    address = getAddress(address);
    if (!Number.isInteger(page) || page < 0 || page > 1000)
      throw new WalletError('INVALID_PAGE', 'Invalid balance page.');
    const fetcher = this.fetcher;
    const response = await fetcher(this.environment.indexerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': this.key,
        Webrpc: 'webrpc@v0.31.2;gen-typescript@v0.23.1;sequence-indexer@v0.4.0',
      },
      body: JSON.stringify({
        chainIds: CHAINS.map((c) => c.id),
        filter: { accountAddresses: [address], omitNativeBalances: false, contractStatus: 'ALL' },
        omitMetadata: false,
        page: { page, pageSize: 40 },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await boundedText(response);
    if (!response.ok)
      throw new WalletError(
        'INDEXER_UNAVAILABLE',
        `Balance service returned HTTP ${response.status}.`,
        502,
      );
    const result = responseSchema.parse(JSON.parse(body));
    const items: Balance[] = [];
    const errors: Balances['errors'] = [];
    for (const [native, groups] of [
      [true, result.nativeBalances],
      [false, result.balances],
    ] as const) {
      for (const group of groups) {
        if (!CHAINS.some((chain) => chain.id === group.chainId)) continue;
        if (group.errorReason) {
          errors.push({ chainId: group.chainId, message: group.errorReason });
          continue;
        }
        if (!group.results) {
          errors.push({ chainId: group.chainId, message: 'No balance result returned.' });
          continue;
        }
        for (const row of group.results) {
          if (
            row.chainId !== group.chainId ||
            row.accountAddress.toLowerCase() !== address.toLowerCase()
          )
            throw new WalletError(
              'INVALID_RESPONSE',
              'Indexer returned balances for a different wallet or network.',
              502,
            );
          if (row.errorReason) {
            errors.push({ chainId: group.chainId, message: row.errorReason });
            continue;
          }
          if (!native && row.contractType !== 'ERC20') continue;
          const chain = requireChain(row.chainId);
          const amount = row.balance ?? row.balanceWei;
          if (amount === undefined || (!native && !row.contractAddress))
            throw new WalletError('INVALID_RESPONSE', 'Incomplete token balance response.', 502);
          items.push({
            chainId: row.chainId,
            asset: native ? 'native' : getAddress(row.contractAddress!),
            name: native ? (row.name ?? chain.name) : (row.contractInfo?.name ?? 'Unknown token'),
            symbol: native ? (row.symbol ?? chain.symbol) : (row.contractInfo?.symbol ?? 'TOKEN'),
            balance: amount,
            decimals: native ? 18 : row.contractInfo?.decimals,
            balanceUSD: row.balanceUSD,
          });
        }
      }
    }
    for (const chain of CHAINS)
      if (!result.nativeBalances.some((group) => group.chainId === chain.id))
        errors.push({ chainId: chain.id, message: 'Native balance unavailable.' });
    return {
      items,
      errors,
      nextPage: result.page?.more ? page + 1 : undefined,
      fetchedAt: new Date().toISOString(),
    };
  }
}
