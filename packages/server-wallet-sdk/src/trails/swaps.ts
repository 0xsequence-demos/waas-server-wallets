import { z } from 'zod';
import { zeroAddress } from 'viem';
import { WalletError } from '../errors.js';
import { sha256 } from '../encoding.js';
import { canonicalJson } from '../json.js';
import type { Operation, Transfer } from '../client.js';
import { TrailsError } from './client.js';
import { buildSwapRequest, tokenAddress, validateSwapQuote, type SwapRequest } from './quote.js';
import { recoveryTokenSchema, type TrailsIntent, type TrailsReceipt } from './protocol.js';
import { validateRecoveryPayload } from './recovery.js';
import { recoveryAuthorization } from './recovery-authorization.js';
import { validateRecoveryTransaction } from './recovery-transaction.js';
import { swapView } from './view.js';
import type { RecoveryRecord, SwapRecord, SwapView, WalletSwapsOptions } from './types.js';

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/)
  .refine((id) => !id.startsWith('swp_'));
const uncertain = (op?: Operation) =>
  !!op && ['submitting', 'pending', 'unknown'].includes(op.status);
const terminalUpstream = new Set(['FAILED', 'ABORTED', 'INVALID', 'REFUNDED', 'SUCCEEDED']);
const emptyCode = (code: string) => /^0x0*$/.test(code);
const errorCode = (error: unknown) =>
  error instanceof WalletError ? error.code : 'SWAP_UNAVAILABLE';

/** Durable backend workflow. The host schedules nextAt and supplies an exclusive wallet coordinator. */
export class WalletSwaps {
  private readonly now: () => number;
  constructor(private readonly options: WalletSwapsOptions) {
    this.now = options.clock ?? Date.now;
  }
  private remote() {
    if (!this.options.trails)
      throw new WalletError('SWAPS_UNAVAILABLE', 'Trails is not configured.', 503);
    return this.options.trails;
  }
  private async enabled(recovery = false) {
    if (!recovery && !this.options.enabled)
      throw new WalletError('SWAPS_DISABLED', 'New swap transactions are disabled.', 409);
    const snapshot = await this.options.wallet.inspect();
    if (snapshot.disabled)
      throw new WalletError('WALLET_DISABLED', 'This wallet is disabled.', 409);
    if (!snapshot.wallet)
      throw new WalletError('WALLET_PENDING', 'Restore this wallet first.', 409);
    return snapshot.wallet.address.toLowerCase();
  }
  private async record(id: string) {
    idSchema.parse(id);
    const record = await this.options.store.get(id);
    if (!record) throw new WalletError('NOT_FOUND', 'Swap not found.', 404);
    this.environment(record);
    const snapshot = await this.options.wallet.inspect();
    if (!snapshot.wallet || snapshot.wallet.address.toLowerCase() !== record.owner)
      throw new WalletError('WALLET_MISMATCH', 'Swap belongs to another wallet.', 409);
    return record;
  }
  private environment(record: SwapRecord) {
    if (record.environment !== (this.options.environment ?? 'default'))
      throw new WalletError(
        'SWAP_ENVIRONMENT_CHANGED',
        'Restore the original Trails endpoint/project before reconciling this swap.',
        409,
      );
  }
  private async save(record: SwapRecord, delay: number | null = record.action ? 5000 : null) {
    record.version++;
    record.updatedAt = new Date(this.now()).toISOString();
    record.nextAt = delay === null ? null : this.now() + delay;
    await this.options.store.save(record);
  }
  private async active() {
    const records = await this.options.store.list({ active: true, limit: 1001 });
    if (records.length > 1000)
      throw new WalletError('WALLET_BUSY', 'Too many unresolved wallet operations.', 409);
    return records;
  }
  private reservedChain(record: SwapRecord): number | undefined {
    const recovery = record.recoveries.find((r) => r.id === record.activeRecoveryId);
    if (recovery) return recovery.chainId;
    if (
      uncertain(record.funding) ||
      (record.confirmedAt &&
        !record.fundingConfirmed &&
        record.action &&
        !['failed', 'expired'].includes(record.phase))
    )
      return record.request.originChainId;
  }
  private async available(chainId: number, exceptSwap?: string, exceptOperations: string[] = []) {
    for (const record of await this.active()) {
      if (record.id !== exceptSwap && this.reservedChain(record) === chainId)
        throw new WalletError(
          'DEBIT_PENDING',
          'Another debit on this chain must be reconciled first.',
          409,
        );
    }
    const disabled = (await this.options.wallet.inspect()).disabled;
    const operations = await this.options.wallet.listOperations(
      await this.options.legacyOperationIds?.(),
    );
    for (let operation of operations) {
      if (
        operation.chainId !== chainId ||
        exceptOperations.includes(operation.id) ||
        !uncertain(operation) ||
        !['transfer', 'deployment', 'recovery'].includes(operation.kind)
      )
        continue;
      if (!disabled)
        operation = (await this.options.wallet.getOperation(operation.id)) ?? operation;
      if (uncertain(operation))
        throw new WalletError(
          'DEBIT_PENDING',
          'A previous wallet transaction has an uncertain or pending debit.',
          409,
        );
    }
  }
  /** Lifecycle and ordinary signing share the workflow lock with swap mutations. */
  walletCommand<T>(task: () => Promise<T>): Promise<T> {
    return this.options.executor.run(task);
  }
  prepareTransfer(id: string, transfer: Transfer) {
    return this.options.executor.run(async () => {
      idSchema.parse(id);
      await this.available(transfer.chainId, undefined, [id]);
      return this.options.wallet.prepareTransfer(id, transfer);
    });
  }
  executeTransfer(id: string) {
    return this.options.executor.run(async () => {
      idSchema.parse(id);
      const op = (await this.options.wallet.listOperations([id])).find((o) => o.id === id);
      if (!op || op.kind !== 'transfer')
        throw new WalletError('NOT_FOUND', 'Transfer not found.', 404);
      if (op.status === 'quoted') await this.available(op.chainId, undefined, [id]);
      return this.options.wallet.executeTransfer(id);
    });
  }
  quoteSwap(id: string, input: SwapRequest): Promise<SwapView> {
    return this.options.executor.run(async () => {
      idSchema.parse(id);
      const owner = await this.enabled();
      const request = buildSwapRequest(owner, input, this.options.assets);
      const requestHash = await sha256(canonicalJson(request));
      const existing = await this.options.store.get(id);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.owner !== owner)
          throw new WalletError(
            'IDEMPOTENCY_CONFLICT',
            'Swap ID was already used with different input.',
            409,
          );
        return swapView(existing);
      }
      const { TrailsContracts } = await this.remote().readiness();
      const { intent } = await this.remote().quoteIntent(request);
      const quote = await validateSwapQuote(intent, request, TrailsContracts, this.now());
      const previous = await this.options.store.findIntent(intent.intentId);
      if (previous && previous !== id)
        throw new WalletError(
          'INTENT_ALREADY_TRACKED',
          'This intent is already tracked by another swap. Open its existing activity.',
          409,
        );
      const timestamp = new Date(this.now()).toISOString();
      const metadata = (chainId: number, token: string) => {
        const asset = this.options.assets.find(
          (a) => a.chainId === chainId && tokenAddress(a.asset) === token,
        )!;
        return {
          decimals: asset.decimals,
          ...(asset.symbol ? { symbol: asset.symbol.slice(0, 32) } : {}),
        };
      };
      const record: SwapRecord = {
        id,
        version: 0,
        requestHash,
        owner,
        environment: this.options.environment ?? 'default',
        assetMetadata: {
          origin: metadata(request.originChainId, request.originTokenAddress),
          destination: metadata(request.destinationChainId, request.destinationTokenAddress),
        },
        request: {
          originChainId: request.originChainId,
          originAsset:
            request.originTokenAddress === zeroAddress ? 'native' : request.originTokenAddress,
          destinationChainId: request.destinationChainId,
          destinationAsset:
            request.destinationTokenAddress === zeroAddress
              ? 'native'
              : request.destinationTokenAddress,
          amount: request.originTokenAmount,
          slippageBps: Math.round(request.options.slippageTolerance * 10000) as 10 | 50 | 100,
        },
        quote,
        phase: 'quoted',
        action: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        nextAt: null,
        attempts: 0,
        fundingId: `swp_fund_${await sha256(id)}`,
        fundingConfirmed: false,
        recoveries: [],
      };
      await this.save(record);
      return swapView(record);
    });
  }
  confirmSwap(id: string, quoteRevision: string): Promise<SwapView> {
    return this.options.executor.run(async () => {
      const record = await this.record(id);
      if (record.quote.digest !== quoteRevision)
        throw new WalletError('STALE_QUOTE', 'Review the current quote before confirming.', 409);
      if (record.confirmedAt) return swapView(record);
      await this.enabled();
      if (record.phase !== 'quoted' || this.expired(record))
        throw new WalletError('QUOTE_EXPIRED', 'Request and review a new quote.', 409);
      await this.available(record.request.originChainId, record.id);
      await this.funds(record);
      record.confirmedAt = new Date(this.now()).toISOString();
      record.phase = 'preparing';
      record.action = 'prepare-funding';
      await this.save(record, 0);
      return swapView(record);
    });
  }
  getSwap(id: string): Promise<SwapView> {
    return this.options.executor.run(async () => {
      const record = await this.record(id);
      if (record.phase === 'quoted' && this.expired(record)) {
        record.phase = 'expired';
        await this.save(record);
      }
      return swapView(record);
    });
  }
  async listSwaps(offset = 0): Promise<SwapView[]> {
    return this.options.executor.run(async () =>
      (
        await this.options.store.list({
          offset: z.number().int().min(0).max(100000).parse(offset),
          limit: 50,
        })
      ).map(swapView),
    );
  }
  reconcileSwap(id: string): Promise<SwapView> {
    return this.options.executor.run(async () => {
      const record = await this.record(id);
      if (record.action && (record.nextAt ?? 0) <= this.now()) await this.advance(record);
      return swapView(record);
    });
  }
  /** One bounded batch. Alarms/Node runners reschedule from persisted nextAt. */
  tick(limit = 3): Promise<void> {
    return this.options.executor.run(async () => {
      const due = (await this.active())
        .filter((r) => r.action && (r.nextAt ?? 0) <= this.now())
        .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0));
      for (const record of due.slice(0, Math.max(1, Math.min(limit, 10))))
        await this.advance(record);
    });
  }
  private expired(record: SwapRecord) {
    return Date.parse(record.quote.expiresAt) <= this.now() + 30_000;
  }
  private async funds(record: SwapRecord) {
    const amount = await this.options.chains.balance(
      record.request.originChainId,
      record.owner,
      record.request.originAsset,
    );
    if (BigInt(amount) < BigInt(record.quote.funding.amount))
      throw new WalletError(
        'INSUFFICIENT_BALANCE',
        'Current on-chain balance is below the reviewed input amount.',
        409,
      );
  }
  private async advance(record: SwapRecord) {
    try {
      this.environment(record);
      // The child journal may be newer than the parent after a crash during submission.
      // Never expire or release a debit using a cached, pre-submission child snapshot.
      if (['prepare-funding', 'activate', 'fund'].includes(record.action ?? '')) {
        record.funding =
          (await this.options.wallet.listOperations([record.fundingId])).find(
            (op) => op.id === record.fundingId,
          ) ?? record.funding;
        if (uncertain(record.funding) || record.funding?.status === 'executed')
          record.action = 'fund';
      }
      const recovery = this.currentRecovery(record, false);
      if (recovery) {
        const children = await this.options.wallet.listOperations([
          recovery.deploymentId,
          recovery.transactionId,
        ]);
        recovery.deployment =
          children.find((op) => op.id === recovery.deploymentId) ?? recovery.deployment;
        recovery.transaction =
          children.find((op) => op.id === recovery.transactionId) ?? recovery.transaction;
        if (uncertain(recovery.deployment) && !(await this.options.wallet.inspect()).disabled)
          recovery.deployment =
            (await this.options.wallet.getOperation(recovery.deploymentId)) ?? recovery.deployment;
        if (uncertain(recovery.transaction) || recovery.transaction?.status === 'executed')
          record.action = 'observe-recovery';
      }
      if (
        ['prepare-funding', 'activate', 'fund'].includes(record.action ?? '') &&
        !uncertain(record.funding) &&
        record.funding?.status !== 'executed' &&
        this.expired(record)
      ) {
        record.phase = 'expired';
        record.action = null;
        record.error = 'QUOTE_EXPIRED';
        await this.save(record);
        return;
      }
      switch (record.action) {
        case 'prepare-funding': {
          await this.enabled();
          await this.available(record.request.originChainId, record.id, [record.fundingId]);
          await this.funds(record);
          await this.save(record);
          record.funding = await this.options.wallet.prepareTransfer(
            record.fundingId,
            record.quote.funding,
          );
          this.sponsored(record.funding);
          record.phase = 'activating';
          record.action = 'activate';
          break;
        }
        case 'activate':
          await this.activate(record);
          break;
        case 'fund':
          await this.fund(record);
          break;
        case 'observe':
          await this.observe(record);
          break;
        case 'deploy-owner':
          await this.deployOwner(record);
          break;
        case 'sign-recovery':
          await this.signRecovery(record);
          break;
        case 'build-recovery':
          await this.buildRecovery(record);
          break;
        case 'submit-recovery':
          await this.submitRecovery(record);
          break;
        case 'observe-recovery':
          await this.observeRecovery(record);
          break;
      }
      record.attempts = 0;
      if (record.phase !== 'attention') record.error = undefined;
      await this.save(
        record,
        record.action ? (record.phase === 'attention' ? 30_000 : 5000) : null,
      );
    } catch (error) {
      record.attempts++;
      record.error = errorCode(error);
      const recovery = this.currentRecovery(record, false);
      if (
        [
          'SPONSORSHIP_REQUIRED',
          'QUOTE_EXPIRED',
          'INVALID_RECOVERY',
          'INVALID_RECOVERY_TRANSACTION',
          'RECOVERY_CHANGED',
          'SIGNATURE_INVALID',
        ].includes(record.error)
      ) {
        if (recovery && !uncertain(recovery.transaction) && !uncertain(recovery.deployment)) {
          recovery.status = 'failed';
          recovery.error = record.error;
          record.activeRecoveryId = undefined;
          record.phase = 'attention';
          record.action = 'observe';
        } else if (!recovery && !record.fundingConfirmed && !uncertain(record.funding)) {
          record.phase = 'failed';
          record.action = null;
        }
      }
      await this.save(
        record,
        record.action ? Math.min(300_000, 5000 * 2 ** Math.min(record.attempts, 6)) : null,
      );
    }
  }
  private sponsored(op: Operation) {
    if (op.status !== 'quoted' || !op.quote?.sponsored)
      throw new WalletError(
        'SPONSORSHIP_REQUIRED',
        'A sponsored prepared transaction is required.',
        409,
      );
    if (Date.parse(op.quote.expiresAt) <= this.now() + 30_000)
      throw new WalletError('QUOTE_EXPIRED', 'Prepared transaction expires too soon.', 409);
  }
  private identity(record: SwapRecord, intent: TrailsIntent) {
    const original = record.quote.intent;
    for (const key of [
      'intentId',
      'ownerAddress',
      'originChainId',
      'destinationChainId',
      'originTokenAddress',
      'destinationTokenAddress',
      'originIntentAddress',
      'destinationIntentAddress',
    ] as const) {
      if (intent[key] !== original[key])
        throw new WalletError(
          'INVALID_RESPONSE',
          'Trails returned a different intent context.',
          502,
        );
    }
  }
  private async receipt(record: SwapRecord): Promise<TrailsReceipt | undefined> {
    try {
      const { intentReceipt } = await this.remote().getIntentReceipt(record.quote.intent.intentId);
      const original = record.quote.intent;
      if (
        intentReceipt.intentId !== original.intentId ||
        intentReceipt.ownerAddress !== record.owner ||
        intentReceipt.originChainId !== record.request.originChainId ||
        intentReceipt.destinationChainId !== record.request.destinationChainId ||
        intentReceipt.summary.originIntentAddress !== original.originIntentAddress ||
        intentReceipt.summary.destinationIntentAddress !==
          (original.destinationIntentAddress ?? original.originIntentAddress)
      )
        throw new WalletError(
          'INVALID_RESPONSE',
          'Receipt does not belong to the reviewed intent.',
          502,
        );
      record.receipt = intentReceipt;
      return intentReceipt;
    } catch (error) {
      if (error instanceof TrailsError && (error.httpStatus === 404 || error.upstreamCode === 8000))
        return undefined;
      throw error;
    }
  }
  private acceptsFunding(record: SwapRecord, receipt?: TrailsReceipt) {
    const deposit = receipt?.depositTransaction;
    return (
      receipt?.status === 'EXECUTING' &&
      !!deposit &&
      ['PENDING', 'MINING', 'SENT', 'RELAYING', 'ON_HOLD'].includes(deposit.status) &&
      deposit.intentId === record.quote.intent.intentId &&
      deposit.chainId === record.request.originChainId &&
      deposit.fromAddress === record.owner &&
      deposit.toAddress === record.quote.intent.originIntentAddress &&
      tokenAddress(deposit.tokenAddress) === tokenAddress(record.request.originAsset) &&
      deposit.tokenAmount === record.quote.funding.amount
    );
  }
  private async activate(record: SwapRecord) {
    await this.enabled();
    this.sponsored(record.funding!);
    const { intent } = await this.remote().getIntent(record.quote.intent.intentId);
    this.identity(record, intent);
    record.upstreamStatus = intent.status;
    if (intent.status === 'QUOTED') {
      await this.save(record);
      await this.remote().executeIntent(intent.intentId);
      return; // Confirm activation with an independent status/receipt read on the next step.
    }
    const receipt = await this.receipt(record);
    if (this.acceptsFunding(record, receipt)) {
      record.phase = 'funding';
      record.action = 'fund';
      return;
    }
    if (terminalUpstream.has(intent.status)) {
      record.phase = 'failed';
      record.action = null;
      record.error = 'INTENT_NOT_FUNDABLE';
    }
  }
  private async fund(record: SwapRecord) {
    const disabled = (await this.options.wallet.inspect()).disabled;
    record.funding = disabled
      ? (await this.options.wallet.listOperations([record.fundingId])).find(
          (op) => op.id === record.fundingId,
        )
      : ((await this.options.wallet.getOperation(record.fundingId)) ?? record.funding);
    if (!record.funding)
      throw new WalletError(
        'FUNDING_UNKNOWN',
        'Funding operation is missing; reconcile before proceeding.',
        409,
      );
    if (record.funding.status === 'quoted') {
      await this.enabled();
      this.sponsored(record.funding);
      await this.available(record.request.originChainId, record.id, [record.fundingId]);
      await this.funds(record);
      const receipt = await this.receipt(record);
      if (!this.acceptsFunding(record, receipt)) {
        if (receipt && terminalUpstream.has(receipt.status)) {
          record.phase = 'failed';
          record.action = null;
          record.error = 'INTENT_NOT_FUNDABLE';
        }
        return;
      }
      await this.save(record);
      record.funding = await this.options.wallet.executeTransfer(record.fundingId);
    }
    if (record.funding.status === 'executed' && record.funding.txnHash) {
      const receipt = await this.options.chains.receipt(
        record.request.originChainId,
        record.funding.txnHash,
      );
      if (receipt?.status === 'success') {
        if (record.request.originAsset !== 'native') {
          const received = receipt.transfers
            .filter(
              (t) =>
                tokenAddress(t.asset) === tokenAddress(record.request.originAsset) &&
                t.from === record.owner &&
                t.to === record.quote.intent.originIntentAddress,
            )
            .reduce((sum, t) => sum + BigInt(t.amount), 0n);
          if (received !== BigInt(record.quote.funding.amount))
            throw new WalletError(
              'FUNDING_RECEIPT_UNVERIFIED',
              'The token receipt does not prove the exact reviewed deposit.',
              409,
            );
        }
        record.fundingConfirmed = true;
        record.phase = 'settling';
        record.action = 'observe';
      } else if (receipt?.status === 'reverted') {
        record.phase = 'attention';
        record.action = 'observe';
        record.error = 'FUNDING_REVERTED';
      }
    } else if (record.funding.status === 'failed') {
      record.phase = 'attention';
      record.action = 'observe';
      record.error = 'FUNDING_FAILED';
    } else if (uncertain(record.funding)) {
      record.phase = 'funding';
      record.error = 'FUNDING_PENDING';
    }
    // Disabled wallets retain uncertain debits; public observations do not trigger reauth.
  }
  private async observe(record: SwapRecord) {
    const { intent } = await this.remote().getIntent(record.quote.intent.intentId);
    this.identity(record, intent);
    record.upstreamStatus = intent.status;
    const receipt = await this.receipt(record);
    if (!receipt) return;
    await this.repairDeposit(record, intent, receipt);
    if (receipt.status === 'SUCCEEDED') {
      if (
        !record.fundingConfirmed ||
        receipt.summary.destinationToAddress !== record.owner ||
        receipt.summary.destinationTokenAddress !== tokenAddress(record.request.destinationAsset) ||
        !receipt.summary.destinationTokenAmount ||
        BigInt(receipt.summary.destinationTokenAmount) <
          BigInt(record.quote.intent.quote.toAmountMin)
      ) {
        record.phase = 'attention';
        record.error = 'SETTLEMENT_REQUIRES_REVIEW';
        return;
      }
      record.phase = 'succeeded';
      record.action = null;
    } else if (receipt.status === 'REFUNDED') {
      const refund = receipt.refundTransaction;
      if (
        !refund ||
        refund.status !== 'SUCCEEDED' ||
        refund.toAddress !== record.owner ||
        ![record.request.originChainId, record.request.destinationChainId].includes(refund.chainId)
      ) {
        record.phase = 'attention';
        record.error = 'REFUND_REQUIRES_REVIEW';
        return;
      }
      record.phase = 'refunded';
      record.action = null;
    } else if (terminalUpstream.has(receipt.status)) {
      record.phase = 'attention';
      record.error = `TRAILS_${receipt.status}`;
    } else if (record.fundingConfirmed) record.phase = 'settling';
  }
  private async repairDeposit(record: SwapRecord, intent: TrailsIntent, receipt: TrailsReceipt) {
    const failed = ['FAILED', 'ABORTED', 'REVERTED'];
    const deposit = receipt.depositTransaction;
    if (
      !record.fundingConfirmed ||
      !record.funding?.txnHash ||
      record.activeRecoveryId ||
      !this.options.enabled ||
      !['EXECUTING', 'INVALID', 'ABORTED'].includes(intent.status) ||
      !deposit ||
      !failed.includes(deposit.status) ||
      (record.repairAttemptedAt && this.now() - Date.parse(record.repairAttemptedAt) < 120_000)
    )
      return;
    for (const dependent of [receipt.originTransaction, receipt.destinationTransaction]) {
      if (!dependent || dependent.status === 'ON_HOLD') continue;
      const reason =
        typeof dependent.statusReason === 'string' ? dependent.statusReason.toLowerCase() : '';
      if (
        !failed.includes(dependent.status) ||
        (!reason.startsWith('deposit transaction') && !reason.startsWith('aborted: deposit'))
      )
        return;
    }
    if (receipt.refundTransaction && !failed.includes(receipt.refundTransaction.status)) return;
    if ((await this.options.wallet.inspect()).disabled) return;
    const proof = await this.options.chains.receipt(
      record.request.originChainId,
      record.funding.txnHash,
    );
    if (proof?.status !== 'success') return;
    record.repairAttemptedAt = new Date(this.now()).toISOString();
    await this.save(record);
    await this.remote().retryIntent(intent.intentId, record.funding.txnHash);
    // Always re-read the same intent on the next tick. This never sends another deposit.
  }
  private currentRecovery(record: SwapRecord, required: true): RecoveryRecord;
  private currentRecovery(record: SwapRecord, required?: false): RecoveryRecord | undefined;
  private currentRecovery(record: SwapRecord, required = false) {
    const recovery = record.recoveries.find((r) => r.id === record.activeRecoveryId);
    if (!recovery && required)
      throw new WalletError('INVALID_RECOVERY', 'No authorized recovery is active.', 409);
    return recovery;
  }
  private async recoveryAllowed(record: SwapRecord) {
    record.funding =
      (await this.options.wallet.listOperations([record.fundingId])).find(
        (op) => op.id === record.fundingId,
      ) ?? record.funding;
    if (uncertain(record.funding))
      throw new WalletError('DEBIT_PENDING', 'Reconcile funding before starting recovery.', 409);
    const { intent } = await this.remote().getIntent(record.quote.intent.intentId);
    this.identity(record, intent);
    const receipt = await this.receipt(record);
    const lastProgress =
      typeof receipt?.updatedAt === 'string'
        ? Date.parse(receipt.updatedAt)
        : Date.parse(record.confirmedAt ?? record.createdAt);
    const stalled =
      intent.status === 'EXECUTING' &&
      this.now() - Date.parse(record.confirmedAt ?? record.createdAt) > 900_000 &&
      this.now() - lastProgress > 300_000;
    if (!terminalUpstream.has(intent.status) && !stalled)
      throw new WalletError(
        'RECOVERY_NOT_READY',
        'The route is still progressing. Recovery is available after failure or a prolonged stall.',
        409,
      );
  }
  prepareRecovery(
    id: string,
    recoveryId: string,
    source: 'origin' | 'destination',
  ): Promise<SwapView> {
    return this.options.executor.run(async () => {
      idSchema.parse(recoveryId);
      z.enum(['origin', 'destination']).parse(source);
      await this.enabled(true);
      const record = await this.record(id);
      const existing = record.recoveries.find((r) => r.id === recoveryId);
      if (existing) {
        if (existing.source !== source)
          throw new WalletError('IDEMPOTENCY_CONFLICT', 'Recovery ID has different input.', 409);
        return swapView(record);
      }
      if (record.activeRecoveryId)
        throw new WalletError('RECOVERY_PENDING', 'Reconcile the active recovery first.', 409);
      await this.recoveryAllowed(record);
      const intent = record.quote.intent;
      const target =
        source === 'origin' ? intent.originIntentAddress : intent.destinationIntentAddress;
      const chainId = source === 'origin' ? intent.originChainId : intent.destinationChainId;
      if (!target)
        throw new WalletError(
          'INVALID_RECOVERY',
          'This intent has no separate destination wallet.',
        );
      await this.available(chainId, record.id, [record.fundingId]);
      const originalPrepared = await this.remote().prepareIntentRecovery(
        intent.intentId,
        target,
        record.owner,
      );
      if (
        originalPrepared.intentAddress !== target ||
        originalPrepared.intentSource !== source ||
        originalPrepared.chainId !== chainId
      )
        throw new WalletError(
          'INVALID_RECOVERY',
          'Recovery response changed the reviewed intent side.',
          502,
        );
      if (record.recoveries.length >= 100)
        throw new WalletError(
          'RECOVERY_LIMIT',
          'Recovery history limit reached; operator intervention is required.',
          409,
        );
      const tokens = z
        .array(recoveryTokenSchema)
        .max(64)
        .parse(originalPrepared.recoveryTokens ?? []);
      const candidates = new Map<string, { symbol: string; decimals: number }>();
      for (const t of tokens) {
        if (t.chainId !== 0 && t.chainId !== chainId)
          throw new WalletError('INVALID_RECOVERY', 'Recovery token belongs to another chain.');
        candidates.set(tokenAddress(t.contractAddress), { symbol: t.symbol, decimals: t.decimals });
      }
      if (!candidates.size) {
        for (const a of this.options.assets.filter((a) => a.chainId === chainId))
          candidates.set(tokenAddress(a.asset), {
            symbol: a.asset === 'native' ? 'Native' : a.asset,
            decimals: a.decimals,
          });
      }
      const assets: RecoveryRecord['assets'] = [];
      for (const [asset, metadata] of candidates) {
        const amount = await this.options.chains.balance(chainId, target, asset);
        if (BigInt(amount) > 0n)
          assets.push({ asset: asset === zeroAddress ? 'native' : asset, amount, ...metadata });
      }
      if (!assets.length)
        throw new WalletError(
          'NO_RECOVERABLE_BALANCE',
          'No recoverable on-chain balance exists on this intent side.',
          409,
        );
      const prepared = recoveryAuthorization(originalPrepared, intent, record.owner, assets);
      const requiresOwnerDeployment = emptyCode(
        await this.options.chains.code(chainId, record.owner),
      );
      const expiresAt = new Date(this.now() + 300_000).toISOString();
      const revision = await sha256(
        canonicalJson({ prepared, assets, requiresOwnerDeployment, expiresAt }),
      );
      const prefix = `swp_${await sha256(`${id}:${recoveryId}`)}`;
      record.recoveries.push({
        id: recoveryId,
        source,
        chainId,
        intentAddress: target,
        prepared,
        originalPrepared,
        assets,
        requiresOwnerDeployment,
        expiresAt,
        revision,
        status: 'quoted',
        deploymentId: `${prefix}_deploy`,
        signingId: `${prefix}_sign`,
        transactionId: `${prefix}_recover`,
      });
      await this.save(record);
      return swapView(record);
    });
  }
  confirmRecovery(id: string, recoveryId: string, revision: string): Promise<SwapView> {
    return this.options.executor.run(async () => {
      const record = await this.record(id);
      const recovery = record.recoveries.find((r) => r.id === recoveryId);
      if (!recovery || recovery.revision !== revision)
        throw new WalletError(
          'STALE_RECOVERY',
          'Review the current recovery before confirming.',
          409,
        );
      if (recovery.status !== 'quoted') return swapView(record);
      await this.enabled(true);
      await this.recoveryAllowed(record);
      if (record.activeRecoveryId)
        throw new WalletError('RECOVERY_PENDING', 'Another recovery is active.', 409);
      await this.available(recovery.chainId, record.id, [record.fundingId]);
      await this.recheckRecovery(record, recovery);
      recovery.status = 'confirmed';
      record.activeRecoveryId = recovery.id;
      record.phase = 'recovering';
      record.action = recovery.requiresOwnerDeployment ? 'deploy-owner' : 'sign-recovery';
      await this.save(record, 0);
      return swapView(record);
    });
  }
  private async recheckRecovery(record: SwapRecord, recovery: RecoveryRecord) {
    if (Date.parse(recovery.expiresAt) <= this.now())
      throw new WalletError('QUOTE_EXPIRED', 'Recovery review expired. Prepare a new review.', 409);
    for (const asset of recovery.assets) {
      if (
        (await this.options.chains.balance(
          recovery.chainId,
          recovery.intentAddress,
          asset.asset,
        )) !== asset.amount
      )
        throw new WalletError(
          'RECOVERY_CHANGED',
          'Recoverable balances changed. Prepare a new review.',
          409,
        );
    }
    validateRecoveryPayload(recovery.prepared, record.quote.intent, record.owner, recovery.assets);
  }
  private async deployOwner(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    if (!emptyCode(await this.options.chains.code(recovery.chainId, record.owner))) {
      record.action = 'sign-recovery';
      return;
    }
    await this.enabled(true);
    recovery.deployment =
      (await this.options.wallet.listOperations([recovery.deploymentId])).find(
        (op) => op.id === recovery.deploymentId,
      ) ?? recovery.deployment;
    if (!uncertain(recovery.deployment) && recovery.deployment?.status !== 'executed') {
      await this.recoveryAllowed(record);
      await this.recheckRecovery(record, recovery);
    }
    recovery.status = 'deploying';
    await this.save(record);
    recovery.deployment = await this.options.wallet.prepareDeployment(
      recovery.deploymentId,
      recovery.chainId,
    );
    if (recovery.deployment.status === 'quoted') {
      this.sponsored(recovery.deployment);
      recovery.deployment = await this.options.wallet.executeOperation(recovery.deploymentId);
    } else
      recovery.deployment =
        (await this.options.wallet.getOperation(recovery.deploymentId)) ?? recovery.deployment;
    if (recovery.deployment.status === 'failed')
      throw new WalletError(
        'INVALID_RECOVERY',
        'Owner deployment failed. Prepare a new recovery review.',
        409,
      );
    if (recovery.deployment.status === 'executed' && recovery.deployment.txnHash) {
      const receipt = await this.options.chains.receipt(
        recovery.chainId,
        recovery.deployment.txnHash,
      );
      if (receipt?.status === 'reverted')
        throw new WalletError(
          'INVALID_RECOVERY',
          'Owner deployment reverted. Prepare a new recovery review.',
          409,
        );
    }
  }
  private async signRecovery(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    await this.enabled(true);
    await this.recoveryAllowed(record);
    await this.recheckRecovery(record, recovery);
    if (emptyCode(await this.options.chains.code(recovery.chainId, record.owner)))
      throw new WalletError(
        'INVALID_RECOVERY',
        'The owner must be deployed on the recovery chain.',
        409,
      );
    recovery.status = 'signing';
    await this.save(record);
    const validated = validateRecoveryPayload(
      recovery.prepared,
      record.quote.intent,
      record.owner,
      recovery.assets,
    );
    recovery.signed = await this.options.wallet.signTypedData(
      recovery.signingId,
      recovery.chainId,
      validated.typedData,
    );
    if (
      !recovery.signed.verified ||
      !recovery.signed.signature ||
      recovery.signed.signature.endsWith('6492'.repeat(16))
    )
      throw new WalletError(
        'INVALID_RECOVERY',
        'A verified deployed-wallet signature is required for Trails recovery.',
        409,
      );
    record.action = 'build-recovery';
  }
  private async buildRecovery(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    await this.enabled(true);
    await this.recheckRecovery(record, recovery);
    recovery.built = await this.remote().buildIntentRecoveryTransaction(
      recovery.prepared,
      recovery.signed!.signature!,
      record.owner,
    );
    const permit = validateRecoveryTransaction(
      recovery.built,
      recovery.prepared,
      record.quote.intent,
      record.owner,
      recovery.assets,
    );
    await this.save(record);
    recovery.transaction = await this.options.wallet.prepareRecoveryTransaction(
      recovery.transactionId,
      permit,
    );
    this.sponsored(recovery.transaction);
    record.action = 'submit-recovery';
  }
  private async submitRecovery(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    await this.enabled(true);
    const op = await this.options.wallet.getOperation(recovery.transactionId);
    if (!op) throw new WalletError('INVALID_RECOVERY', 'Prepared recovery is missing.', 409);
    if (op.status === 'quoted') {
      this.sponsored(op);
      await this.recoveryAllowed(record);
      await this.recheckRecovery(record, recovery);
      await this.available(recovery.chainId, record.id, [
        record.fundingId,
        recovery.deploymentId,
        recovery.transactionId,
      ]);
      validateRecoveryTransaction(
        recovery.built,
        recovery.prepared,
        record.quote.intent,
        record.owner,
        recovery.assets,
      );
      recovery.ownerBalances = [];
      for (const asset of recovery.assets)
        recovery.ownerBalances.push({
          asset: asset.asset,
          amount: await this.options.chains.balance(recovery.chainId, record.owner, asset.asset),
        });
      recovery.status = 'submitting';
      await this.save(record);
      recovery.transaction = await this.options.wallet.executeOperation(recovery.transactionId);
    } else recovery.transaction = op;
    recovery.status = 'pending';
    record.action = 'observe-recovery';
  }
  private async observeRecovery(record: SwapRecord) {
    const recovery = this.currentRecovery(record, true);
    if (!(await this.options.wallet.inspect()).disabled)
      recovery.transaction =
        (await this.options.wallet.getOperation(recovery.transactionId)) ?? recovery.transaction;
    if (recovery.transaction?.status === 'failed') {
      recovery.status = 'failed';
      recovery.error = 'RECOVERY_FAILED';
      record.activeRecoveryId = undefined;
      record.phase = 'attention';
      record.action = 'observe';
      return;
    }
    if (recovery.transaction?.status !== 'executed' || !recovery.transaction.txnHash) return;
    const receipt = await this.options.chains.receipt(
      recovery.chainId,
      recovery.transaction.txnHash,
    );
    if (receipt?.status === 'reverted')
      throw new WalletError(
        'INVALID_RECOVERY_TRANSACTION',
        'Recovery reverted on chain. Prepare a new recovery review.',
        409,
      );
    if (receipt?.status !== 'success') return;
    const recovered: RecoveryRecord['assets'] = [];
    let partial = false;
    for (const asset of recovery.assets) {
      const remaining = await this.options.chains.balance(
        recovery.chainId,
        recovery.intentAddress,
        asset.asset,
      );
      const ownerAfter = await this.options.chains.balance(
        recovery.chainId,
        record.owner,
        asset.asset,
      );
      const before = recovery.ownerBalances?.find((b) => b.asset === asset.asset)?.amount;
      const logged = receipt.transfers
        .filter(
          (t) =>
            tokenAddress(t.asset) === tokenAddress(asset.asset) &&
            t.to === record.owner &&
            t.from === recovery.intentAddress,
        )
        .reduce((sum, t) => sum + BigInt(t.amount), 0n);
      const actual = asset.asset === 'native' ? BigInt(asset.amount) : logged;
      if (
        before === undefined ||
        (asset.asset === 'native' && BigInt(ownerAfter) < BigInt(before) + actual)
      )
        throw new WalletError(
          'RECOVERY_EVIDENCE_PENDING',
          'Waiting for recovered balances to be confirmed.',
          409,
        );
      recovered.push({ ...asset, amount: actual.toString() });
      partial ||= BigInt(remaining) > 0n || actual < BigInt(asset.amount);
    }
    recovery.received = recovered;
    recovery.status = partial ? 'partial' : 'recovered';
    recovery.error = partial ? 'RECOVERY_PARTIAL' : undefined;
    record.activeRecoveryId = undefined;
    record.phase = partial ? 'attention' : 'refunded';
    record.error = partial ? 'RECOVERY_PARTIAL' : undefined;
    record.action = partial ? 'observe' : null;
  }
}
