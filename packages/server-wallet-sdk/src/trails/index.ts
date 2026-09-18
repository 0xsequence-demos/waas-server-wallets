export { TrailsClient, TrailsError } from './client.js';
export type { TrailsClientOptions } from './client.js';
export { buildSwapRequest, validateSwapQuote, tokenAddress } from './quote.js';
export type { SwapRequest, SwapAsset, SwapQuote, SwapQuoteRequest } from './quote.js';
export { validateRecoveryPayload } from './recovery.js';
export type { TrailsIntent, TrailsToken, TrailsContracts, PreparedRecovery } from './protocol.js';
export { WalletSwaps } from './swaps.js';
export { EvmChainReader } from './chain.js';
export type { ChainReader, ChainReceipt } from './chain.js';
export { validateRecoveryTransaction } from './recovery-transaction.js';
export { swapView } from './view.js';
export type {
  SwapRecord,
  SwapStore,
  SwapGateway,
  WalletSwapsOptions,
  SwapView,
  SwapPhase,
  SwapAction,
  RecoveryRecord,
  RecoveryView,
  RecoveryAsset,
  TransactionView,
} from './types.js';
export type { TrailsReceipt, BuiltRecovery } from './protocol.js';
export { recoveryAuthorization } from './recovery-authorization.js';
