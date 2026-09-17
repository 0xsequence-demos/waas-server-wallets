import { WalletError } from './errors.js';
export const CHAINS = [
  { id: 137, name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.com' },
  { id: 42161, name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbiscan.io' },
  { id: 8453, name: 'Base', symbol: 'ETH', explorer: 'https://basescan.org' },
  { id: 56, name: 'BNB Chain', symbol: 'BNB', explorer: 'https://bscscan.com' },
  { id: 1, name: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io' },
] as const;
export function requireChain(id: number) {
  const chain = CHAINS.find((entry) => entry.id === id);
  if (!chain)
    throw new WalletError('UNSUPPORTED_CHAIN', 'Select one of the configured EVM networks.');
  return chain;
}
export function environmentFromKey(key: string) {
  const match = /^pk_(?:(local|dev|stg)_)?(sdbx|live)_([A-Za-z0-9]+)_([A-Za-z0-9-]+)$/.exec(key);
  if (!match) throw new WalletError('CONFIGURATION', 'Configure a valid OMS publishable key.', 503);
  const [, stage, mode, project] = match;
  const prefix = mode === 'sdbx' ? 'sandbox-api' : 'api';
  const origin = stage
    ? `https://${prefix}.${stage}.polygon-dev.technology`
    : `https://${prefix}.polygon.technology`;
  return {
    projectId: `prj_${project}`,
    origin,
    indexerUrl: `${origin}/v1/IndexerGateway/GetTokenBalancesDetails`,
    stage: stage ?? 'production',
    mode,
  };
}
