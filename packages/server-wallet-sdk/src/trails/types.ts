import type { ServerWallet, Operation } from '../client.js';
import type { ExclusiveExecutor } from '../storage.js';
import type { TrailsClient } from './client.js';
import type { ChainReader } from './chain.js';
import type { SwapAsset, SwapQuote, SwapRequest } from './quote.js';
import type { PreparedRecovery, BuiltRecovery, TrailsReceipt } from './protocol.js';

export type SwapPhase =
  | 'quoted'
  | 'preparing'
  | 'activating'
  | 'funding'
  | 'settling'
  | 'succeeded'
  | 'expired'
  | 'failed'
  | 'attention'
  | 'recovering'
  | 'refunded';
export type SwapAction =
  | 'prepare-funding'
  | 'activate'
  | 'fund'
  | 'observe'
  | 'deploy-owner'
  | 'sign-recovery'
  | 'build-recovery'
  | 'submit-recovery'
  | 'observe-recovery'
  | null;
export interface RecoveryAsset {
  asset: string;
  amount: string;
  decimals: number;
  symbol: string;
}
export interface RecoveryRecord {
  id: string;
  source: 'origin' | 'destination';
  chainId: number;
  intentAddress: string;
  revision: string;
  expiresAt: string;
  assets: RecoveryAsset[];
  requiresOwnerDeployment: boolean;
  status:
    | 'quoted'
    | 'confirmed'
    | 'deploying'
    | 'signing'
    | 'submitting'
    | 'pending'
    | 'recovered'
    | 'partial'
    | 'failed'
    | 'expired';
  prepared: PreparedRecovery;
  originalPrepared?: PreparedRecovery;
  signed?: Operation;
  built?: BuiltRecovery;
  deploymentId: string;
  signingId: string;
  transactionId: string;
  deployment?: Operation;
  transaction?: Operation;
  ownerBalances?: { asset: string; amount: string }[];
  error?: string;
  received?: RecoveryAsset[];
}
/** Private authoritative record. Persist encrypted; never send this shape to a browser. */
export interface SwapRecord {
  id: string;
  version: number;
  requestHash: string;
  request: SwapRequest;
  owner: string;
  environment: string;
  assetMetadata?: {
    origin: { decimals: number; symbol?: string };
    destination: { decimals: number; symbol?: string };
  };
  quote: SwapQuote;
  phase: SwapPhase;
  action: SwapAction;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  nextAt: number | null;
  attempts: number;
  error?: string;
  fundingId: string;
  funding?: Operation;
  fundingConfirmed: boolean;
  upstreamStatus?: string;
  receipt?: TrailsReceipt;
  repairAttemptedAt?: string;
  recoveries: RecoveryRecord[];
  activeRecoveryId?: string;
}
/** Every save atomically replaces one record including its action and wake-up time. */
export interface SwapStore {
  get(id: string): Promise<SwapRecord | null>;
  findIntent(intentId: string): Promise<string | null>;
  save(record: SwapRecord): Promise<void>;
  list(options: { active?: boolean; offset?: number; limit: number }): Promise<SwapRecord[]>;
}
export type SwapGateway = Pick<
  TrailsClient,
  | 'readiness'
  | 'quoteIntent'
  | 'getIntent'
  | 'executeIntent'
  | 'getIntentReceipt'
  | 'retryIntent'
  | 'prepareIntentRecovery'
  | 'buildIntentRecoveryTransaction'
>;
export interface WalletSwapsOptions {
  wallet: ServerWallet;
  trails?: SwapGateway;
  chains: ChainReader;
  store: SwapStore;
  /** Shared by every swap and ordinary debit for this wallet; distinct from credential executor. */
  executor: ExclusiveExecutor;
  assets: readonly SwapAsset[];
  enabled?: boolean;
  clock?: () => number;
  /** Stable endpoint/project identity, never an API key. A mismatch blocks replay. */
  environment?: string;
  /** Import operation IDs from applications that predate the SDK's operation index. */
  legacyOperationIds?: () => Promise<string[]>;
}
export interface TransactionView {
  status: string;
  hash?: string;
  chainId: number;
  sponsored: boolean;
}
export interface RecoveryView {
  id: string;
  source: 'origin' | 'destination';
  chainId: number;
  intentAddress: string;
  revision: string;
  expiresAt: string;
  assets: RecoveryAsset[];
  requiresOwnerDeployment: boolean;
  status: RecoveryRecord['status'];
  deployment?: TransactionView;
  transaction?: TransactionView;
  error?: string;
  received?: RecoveryAsset[];
}
export interface SwapView {
  id: string;
  version: number;
  request: SwapRequest;
  owner: string;
  assetMetadata?: SwapRecord['assetMetadata'];
  phase: SwapPhase;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  error?: string;
  nextAt: number | null;
  quote: {
    revision: string;
    expiresAt: string;
    intentId: string;
    expectedOutput: string;
    minimumOutput: string;
    inputAmount: string;
    providers: string[];
    estimatedDuration?: number | null;
    priceImpact: number;
    fees: { totalUsd: number; gasUsd: number; trailsUsd: number; providerUsd: number };
  };
  funding?: TransactionView;
  upstreamStatus?: string;
  transactions: { chainId: number; type: string; status: string; hash?: string }[];
  outputAmount?: string;
  recoveries: RecoveryView[];
  canRecover: boolean;
  refund?: { chainId: number; asset: string; amount: string; hash?: string; status: string };
}
