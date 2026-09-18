import { z } from 'zod';
import { CHAINS, WalletError } from '@polygonlabs/oms-server-wallet-sdk';
import {
  TrailsClient,
  tokenAddress,
  type SwapAsset,
} from '@polygonlabs/oms-server-wallet-sdk/trails';
import type { Config } from './config.js';

export interface DisplayAsset extends SwapAsset {
  symbol: string;
  name: string;
}
// Contract identities, never symbol matching. Bridged/pegged assets are named explicitly.
export const SWAP_ASSETS: readonly DisplayAsset[] = [
  ...CHAINS.map((c) => ({
    chainId: c.id,
    asset: 'native',
    decimals: 18,
    symbol: c.symbol,
    name: c.symbol,
  })),
  {
    chainId: 1,
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  {
    chainId: 137,
    asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  {
    chainId: 42161,
    asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  {
    chainId: 8453,
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC',
  },
  {
    chainId: 1,
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD',
  },
  {
    chainId: 137,
    asset: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD (bridged)',
  },
  {
    chainId: 42161,
    asset: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD',
  },
  {
    chainId: 56,
    asset: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    decimals: 18,
    symbol: 'USDC',
    name: 'Binance-Peg USDC',
  },
  {
    chainId: 56,
    asset: '0x55d398326f99059ff775485246999027b3197955',
    decimals: 18,
    symbol: 'USDT',
    name: 'Binance-Peg USDT',
  },
];
const defaults: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  137: 'https://polygon-bor-rpc.publicnode.com',
  42161: 'https://arb1.arbitrum.io/rpc',
  8453: 'https://mainnet.base.org',
  56: 'https://bsc-dataseed.bnbchain.org',
};
export function rpcUrls(config: Config): Record<number, string> {
  try {
    const overrides = z.record(z.string(), z.url()).parse(JSON.parse(config.EVM_RPC_URLS || '{}'));
    for (const [id, endpoint] of Object.entries(overrides)) {
      const url = new URL(endpoint);
      if (
        !CHAINS.some((c) => c.id === Number(id)) ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error();
    }
    return { ...defaults, ...overrides };
  } catch {
    throw new WalletError(
      'RPC_CONFIGURATION',
      'EVM_RPC_URLS must map supported chain IDs to HTTPS endpoints.',
      503,
    );
  }
}
export function trailsClient(config: Config) {
  return config.TRAILS_API_KEY
    ? new TrailsClient({
        apiKey: config.TRAILS_API_KEY,
        baseUrl: config.TRAILS_API_URL,
        origin: new URL(config.APP_ORIGIN).origin,
      })
    : undefined;
}
export function trailsEnvironment(config: Config) {
  return JSON.stringify([config.TRAILS_API_URL, config.TRAILS_PROJECT_ID]);
}
export async function discoverSwapAssets(client: TrailsClient) {
  const [chainResult, tokenResult] = await Promise.all([
    client.getChains(),
    client.getTokenList(CHAINS.map((c) => c.id)),
  ]);
  return SWAP_ASSETS.filter(
    (asset) =>
      chainResult.chains.some((c) => c.id === asset.chainId) &&
      tokenResult.tokens.some(
        (t) =>
          t.chainId === asset.chainId &&
          tokenAddress(t.address) === tokenAddress(asset.asset) &&
          t.decimals === asset.decimals &&
          !t.feeOnTransfer,
      ),
  );
}
export async function swapConfiguration(config: Config) {
  const base = {
    enabled: false,
    ready: false,
    chains: CHAINS,
    assets: [] as DisplayAsset[],
    slippageBps: [10, 50, 100],
    fundingGas: 'sponsored',
    feePolicy: 'Trails route fees are paid from swap funds.',
  };
  if (!config.TRAILS_API_KEY) return { ...base, reason: 'Swaps are not configured yet.' };
  try {
    const client = trailsClient(config)!;
    rpcUrls(config);
    await client.readiness();
    const assets = await discoverSwapAssets(client);
    return {
      ...base,
      assets,
      ready: true,
      enabled: config.SWAPS_ENABLED === 'true',
      reason:
        config.SWAPS_ENABLED === 'true'
          ? undefined
          : 'New swaps are paused. Existing swaps and recovery remain available.',
    };
  } catch {
    return {
      ...base,
      reason: 'Swap services are temporarily unavailable. Existing activity remains available.',
    };
  }
}
