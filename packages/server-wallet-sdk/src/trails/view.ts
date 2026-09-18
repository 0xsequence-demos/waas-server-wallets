import type { Operation } from '../client.js';
import type { SwapRecord, SwapView, TransactionView } from './types.js';

export const transactionView = (op?: Operation): TransactionView | undefined =>
  op
    ? {
        status: op.status,
        hash: publicHash(op.txnHash),
        chainId: op.chainId,
        sponsored: op.quote?.sponsored === true,
      }
    : undefined;
export function publicHash(hash?: string | null) {
  return hash &&
    /^0x[0-9a-fA-F]{64}$/.test(hash) &&
    !/^0x0{64}$/.test(hash) &&
    !/^0xf{64}$/i.test(hash)
    ? hash
    : undefined;
}
/** Explicit projection: never spreads private records, signatures, typed data or upstream errors. */
export function swapView(record: SwapRecord): SwapView {
  const intent = record.quote.intent;
  return {
    id: record.id,
    version: record.version,
    request: { ...record.request },
    owner: record.owner,
    assetMetadata: record.assetMetadata
      ? {
          origin: { ...record.assetMetadata.origin },
          destination: { ...record.assetMetadata.destination },
        }
      : undefined,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    confirmedAt: record.confirmedAt,
    error: record.error,
    nextAt: record.nextAt,
    upstreamStatus: record.upstreamStatus,
    quote: {
      revision: record.quote.digest,
      expiresAt: record.quote.expiresAt,
      intentId: intent.intentId,
      expectedOutput: intent.quote.toAmount,
      minimumOutput: intent.quote.toAmountMin,
      inputAmount: record.quote.funding.amount,
      providers: [...intent.quote.routeProviders],
      estimatedDuration: intent.quote.estimatedDuration,
      priceImpact: intent.quote.priceImpact,
      fees: {
        totalUsd: intent.fees.totalFeeUsd,
        gasUsd: intent.fees.gasFeeUsd,
        trailsUsd: intent.fees.trailsFeeUsd,
        providerUsd: intent.fees.providerFeeUsd,
      },
    },
    funding: transactionView(record.funding),
    transactions: [
      record.receipt?.depositTransaction,
      record.receipt?.originTransaction,
      record.receipt?.destinationTransaction,
      record.receipt?.refundTransaction,
    ]
      .filter((t) => !!t)
      .map((t) => ({
        chainId: t.chainId,
        type: t.type,
        status: t.status,
        hash: t.type === 'DEPOSIT' ? publicHash(record.funding?.txnHash) : publicHash(t.txnHash),
      })),
    outputAmount: record.receipt?.summary.destinationTokenAmount ?? undefined,
    refund:
      record.receipt?.refundTransaction &&
      record.receipt.refundTransaction.toAddress === record.owner
        ? {
            chainId: record.receipt.refundTransaction.chainId,
            asset: record.receipt.refundTransaction.tokenAddress,
            amount: record.receipt.refundTransaction.tokenAmount,
            hash: publicHash(record.receipt.refundTransaction.txnHash),
            status: record.receipt.refundTransaction.status,
          }
        : undefined,
    recoveries: record.recoveries.map((r) => ({
      id: r.id,
      source: r.source,
      chainId: r.chainId,
      intentAddress: r.intentAddress,
      revision: r.revision,
      expiresAt: r.expiresAt,
      assets: r.assets.map((a) => ({ ...a })),
      requiresOwnerDeployment: r.requiresOwnerDeployment,
      status: r.status,
      deployment: transactionView(r.deployment),
      transaction: transactionView(r.transaction),
      error: r.error,
      received: r.received?.map((asset) => ({ ...asset })),
    })),
    canRecover:
      !record.activeRecoveryId &&
      (record.fundingConfirmed ||
        ['succeeded', 'failed', 'refunded', 'attention'].includes(record.phase)),
  };
}
