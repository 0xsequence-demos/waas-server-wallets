import { z } from 'zod';
import { encodeFunctionData, getAddress, isAddress, parseUnits } from 'viem';
import { sha256 } from './encoding.js';
import { requireChain } from './environment.js';
import { UpstreamError, WalletError } from './errors.js';
import {
  authSchema,
  credentialId,
  generateCredential,
  listSchema,
  quoteSchema,
  statusSchema,
  walletSchema,
  type Credential,
  type RemoteWallet,
  type Quote,
} from './protocol.js';
import type { ExclusiveExecutor, StateStore } from './storage.js';
import type { RpcTransport } from './transport.js';

export interface WalletSnapshot {
  wallet?: RemoteWallet;
  disabled: boolean;
  expiresAt?: string;
  credentialId?: string;
  creationUncertain: boolean;
}
interface State {
  wallet?: RemoteWallet;
  credential?: Credential;
  disabled: boolean;
  creating: boolean;
}
export interface Transfer {
  chainId: number;
  to: string;
  asset: 'native' | string;
  amount: string;
}
export interface Operation {
  id: string;
  kind: 'transfer' | 'sign';
  inputHash: string;
  createdAt: string;
  status:
    | 'preparing'
    | 'quoted'
    | 'submitting'
    | 'pending'
    | 'executed'
    | 'failed'
    | 'unknown'
    | 'signed';
  chainId: number;
  transfer?: Transfer;
  quote?: Quote;
  signature?: string;
  verified?: boolean;
  txnHash?: string;
  error?: string;
}
export interface ServerWalletOptions {
  subject: string;
  issuer: string;
  audience: string;
  tokenProvider: () => Promise<{ token: string; expiresAt: number }>;
  store: StateStore;
  executor: ExclusiveExecutor;
  transport: RpcTransport;
  sessionLifetimeSeconds?: number;
}
const signatureSchema = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });
const validSchema = z.object({ isValid: z.boolean() });
const okSchema = z.object({ ok: z.literal(true) });
const transferSchema = z
  .object({
    chainId: z.number().int(),
    to: z.string(),
    asset: z.string(),
    amount: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .max(78),
  })
  .strict();

export function parseAmount(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) ||
    (value.split('.')[1]?.length ?? 0) > decimals
  )
    throw new WalletError(
      'INVALID_AMOUNT',
      'Enter a positive amount within the token’s decimal precision.',
    );
  const amount = parseUnits(value, decimals);
  if (amount <= 0n || amount >= 2n ** 256n)
    throw new WalletError('INVALID_AMOUNT', 'Amount is outside the supported range.');
  return amount.toString();
}

/** One instance represents one OIDC identity and one EVM wallet. */
export class ServerWallet {
  constructor(private readonly options: ServerWalletOptions) {
    if (!options.subject || options.subject.length > 128)
      throw new WalletError(
        'INVALID_IDENTITY',
        'Wallet identifiers must contain 1–128 characters.',
      );
  }
  private async load(): Promise<State> {
    const value = await this.options.store.read('wallet');
    const state: State = value ? JSON.parse(value) : { disabled: false, creating: false };
    // Upgrade encrypted records created before RPC identifiers were stored separately.
    if (state.credential && !state.credential.credentialId)
      state.credential.credentialId = await credentialId(state.credential.id);
    return state;
  }
  private save(state: State) {
    return this.options.store.write('wallet', JSON.stringify(state));
  }
  private snapshot(state: State): WalletSnapshot {
    return {
      wallet: state.wallet,
      disabled: state.disabled,
      expiresAt: state.credential?.expiresAt,
      credentialId: state.credential?.credentialId,
      creationUncertain: state.creating,
    };
  }
  inspect(): Promise<WalletSnapshot> {
    return this.options.executor.run(async () => this.snapshot(await this.load()));
  }
  createOrRestore(): Promise<WalletSnapshot> {
    return this.options.executor.run(async () => {
      const state = await this.load();
      await this.ensure(state);
      return this.snapshot(state);
    });
  }
  private async call(
    state: State,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!state.credential) throw new WalletError('NO_CREDENTIAL', 'Credential unavailable.');
    const next = BigInt(state.credential.nonce) + 1n;
    state.credential.nonce = (next > BigInt(Date.now()) ? next : BigInt(Date.now())).toString();
    await this.save(state);
    return this.options.transport.request(method, params, state.credential);
  }
  private async activeCall(
    state: State,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ensure(state);
    try {
      return await this.call(state, method, params);
    } catch (error) {
      // Verified authentication failures precede execution. Revoked keys return 7207.
      // Retry once with a new credential; a persistent authorization failure still propagates.
      if (!(error instanceof UpstreamError) || ![7202, 7203, 7207].includes(error.upstreamCode))
        throw error;
      state.credential = undefined;
      await this.save(state);
      await this.ensure(state);
      return this.call(state, method, params);
    }
  }
  private async ensure(state: State): Promise<void> {
    if (state.disabled) throw new WalletError('WALLET_DISABLED', 'This wallet is disabled.', 409);
    if (
      !state.credential?.expiresAt ||
      Date.parse(state.credential.expiresAt) <= Date.now() + 60_000 ||
      (state.creating && !state.wallet)
    ) {
      state.credential = await generateCredential();
      await this.save(state);
      const { token, expiresAt } = await this.options.tokenProvider();
      const handle = await sha256(token);
      const committed = z.object({ verifier: z.string() }).parse(
        await this.call(state, 'CommitVerifier', {
          identityType: 'oidc',
          authMode: 'id-token',
          handle,
          metadata: {
            iss: this.options.issuer,
            aud: this.options.audience,
            exp: String(expiresAt),
          },
        }),
      );
      const authenticated = authSchema.parse(
        await this.call(state, 'CompleteAuth', {
          identityType: 'oidc',
          authMode: 'id-token',
          verifier: committed.verifier,
          answer: token,
          lifetime: this.options.sessionLifetimeSeconds ?? 21_600,
        }),
      );
      if (
        authenticated.identity.sub !== this.options.subject ||
        authenticated.identity.iss.replace(/\/$/, '') !== this.options.issuer.replace(/\/$/, '') ||
        authenticated.credential.credentialId.toLowerCase() !== state.credential.credentialId
      )
        throw new WalletError(
          'IDENTITY_MISMATCH',
          'WaaS returned a different identity or credential.',
          502,
        );
      const wallets = [...authenticated.wallets];
      let cursor = authenticated.page?.cursor;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor) || seen.size >= 100)
          throw new WalletError('INVALID_RESPONSE', 'Wallet pagination did not terminate.', 502);
        seen.add(cursor);
        const page = listSchema.parse(
          await this.call(state, 'ListWallets', { page: { cursor, limit: 100 } }),
        );
        wallets.push(...page.wallets);
        cursor = page.page?.cursor;
      }
      const evm = wallets.filter(
        (wallet) => wallet.networkFamily === 'evm' || wallet.type === 'ethereum',
      );
      if (
        evm.length > 1 ||
        (state.wallet &&
          !evm.some(
            (wallet) =>
              wallet.id === state.wallet?.id &&
              wallet.address.toLowerCase() === state.wallet.address.toLowerCase(),
          ))
      )
        throw new WalletError(
          'WALLET_MISMATCH',
          'Identity does not map to the expected single wallet.',
          409,
        );
      if (evm.length === 1) {
        state.wallet = walletSchema.parse(
          z
            .object({ wallet: walletSchema })
            .parse(await this.call(state, 'UseWallet', { walletId: evm[0].id })).wallet,
        );
        if (
          state.wallet.id !== evm[0].id ||
          state.wallet.address.toLowerCase() !== evm[0].address.toLowerCase()
        )
          throw new WalletError(
            'WALLET_MISMATCH',
            'Wallet binding returned a different wallet.',
            502,
          );
        state.creating = false;
      }
      state.credential.expiresAt = authenticated.credential.expiresAt;
      await this.save(state);
    }
    if (!state.wallet) {
      if (state.creating)
        throw new WalletError(
          'CREATION_UNCERTAIN',
          'A previous create request has an unknown outcome. Restore again after upstream recovery; no duplicate wallet will be created.',
          409,
        );
      state.creating = true;
      await this.save(state);
      try {
        const result = z.object({ wallet: walletSchema }).parse(
          await this.call(state, 'CreateWallet', {
            networkFamily: 'evm',
            reference: this.options.subject,
          }),
        );
        state.wallet = result.wallet;
        state.creating = false;
        await this.save(state);
      } catch (error) {
        // Force discovery next time, even when the create response was lost.
        state.credential.expiresAt = undefined;
        await this.save(state);
        throw error;
      }
    }
  }
  rotate(): Promise<WalletSnapshot> {
    return this.options.executor.run(async () => {
      const state = await this.load();
      if (state.disabled)
        throw new WalletError('WALLET_DISABLED', 'Enable the wallet before rotating.', 409);
      await this.revoke(state);
      await this.ensure(state);
      return this.snapshot(state);
    });
  }
  setDisabled(disabled: boolean): Promise<WalletSnapshot> {
    return this.options.executor.run(async () => {
      const state = await this.load();
      // Persist disabling before I/O. Keep it disabled until retained keys are revoked on enable.
      if (disabled) {
        state.disabled = true;
        await this.save(state);
      }
      await this.revoke(state);
      if (!disabled) {
        state.disabled = false;
        await this.save(state);
        await this.ensure(state);
      }
      return this.snapshot(state);
    });
  }
  private async revoke(state: State): Promise<void> {
    if (state.credential?.expiresAt && Date.parse(state.credential.expiresAt) > Date.now()) {
      try {
        okSchema.parse(
          await this.call(state, 'RevokeCredential', {
            credentialId: state.credential.credentialId,
          }),
        );
      } catch (error) {
        if (!(error instanceof UpstreamError) || ![7202, 7203, 7207].includes(error.upstreamCode))
          throw error;
      }
    }
    state.credential = undefined;
    await this.save(state);
  }
  private async readOperation(id: string): Promise<Operation | null> {
    const value = await this.options.store.read(`operation:${id}`);
    return value ? (JSON.parse(value) as Operation) : null;
  }
  private writeOperation(op: Operation) {
    return this.options.store.write(`operation:${op.id}`, JSON.stringify(op));
  }
  private async existing(
    id: string,
    kind: Operation['kind'],
    input: unknown,
  ): Promise<{ operation: Operation | null; hash: string }> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id))
      throw new WalletError(
        'INVALID_IDEMPOTENCY_KEY',
        'An operation ID of 8–100 letters, digits, underscores or hyphens is required.',
      );
    const hash = await sha256(JSON.stringify(input));
    const operation = await this.readOperation(id);
    if (operation && (operation.inputHash !== hash || operation.kind !== kind))
      throw new WalletError(
        'IDEMPOTENCY_CONFLICT',
        'This operation ID was already used with different input.',
        409,
      );
    return { operation, hash };
  }
  prepareTransfer(id: string, input: Transfer): Promise<Operation> {
    return this.options.executor.run(async () => {
      const parsed = transferSchema.safeParse(input);
      if (!parsed.success)
        throw new WalletError(
          'INVALID_TRANSFER',
          'Provide a chain, recipient, asset, and positive base-unit amount.',
        );
      const transfer = parsed.data;
      requireChain(transfer.chainId);
      if (!isAddress(transfer.to) || (transfer.asset !== 'native' && !isAddress(transfer.asset)))
        throw new WalletError(
          'INVALID_ADDRESS',
          'Provide valid EVM recipient and token addresses.',
        );
      transfer.to = getAddress(transfer.to);
      if (transfer.asset !== 'native') transfer.asset = getAddress(transfer.asset);
      if (BigInt(transfer.amount) >= 2n ** 256n)
        throw new WalletError('INVALID_AMOUNT', 'Amount exceeds uint256.');
      const { operation, hash } = await this.existing(id, 'transfer', transfer);
      if (operation) return operation;
      const state = await this.load();
      await this.ensure(state);
      const op: Operation = {
        id,
        kind: 'transfer',
        inputHash: hash,
        createdAt: new Date().toISOString(),
        chainId: transfer.chainId,
        status: 'preparing',
        transfer,
      };
      await this.writeOperation(op);
      const native = transfer.asset === 'native';
      const data = native
        ? undefined
        : encodeFunctionData({
            abi: [
              {
                type: 'function',
                name: 'transfer',
                inputs: [{ type: 'address' }, { type: 'uint256' }],
                outputs: [{ type: 'bool' }],
                stateMutability: 'nonpayable',
              },
            ],
            functionName: 'transfer',
            args: [getAddress(transfer.to), BigInt(transfer.amount)],
          });
      try {
        op.quote = quoteSchema.parse(
          await this.activeCall(state, 'PrepareEthereumTransaction', {
            network: String(transfer.chainId),
            walletId: state.wallet!.id,
            to: native ? transfer.to : transfer.asset,
            value: native ? transfer.amount : '0',
            ...(data ? { data } : {}),
            mode: 'relayer',
          }),
        );
        if (!op.quote.sponsored)
          throw new WalletError(
            'SPONSORSHIP_REQUIRED',
            'This transfer is not sponsored. Enable gas sponsorship for this project/network.',
            409,
          );
        op.status = 'quoted';
        await this.writeOperation(op);
        return op;
      } catch (error) {
        op.status = 'failed';
        op.error = error instanceof WalletError ? error.code : 'PREPARATION_FAILED';
        await this.writeOperation(op);
        throw error;
      }
    });
  }
  executeTransfer(id: string): Promise<Operation> {
    return this.options.executor.run(async () => {
      const op = await this.readOperation(id);
      if (!op || op.kind !== 'transfer')
        throw new WalletError('NOT_FOUND', 'Transfer not found.', 404);
      if (op.status !== 'quoted') return this.refresh(op);
      if (!op.quote?.sponsored)
        throw new WalletError('SPONSORSHIP_REQUIRED', 'Transfer requires gas sponsorship.', 409);
      if (Date.parse(op.quote.expiresAt) <= Date.now())
        throw new WalletError('QUOTE_EXPIRED', 'The quote expired. Prepare a new transfer.', 409);
      const state = await this.load();
      await this.ensure(state);
      op.status = 'submitting';
      await this.writeOperation(op);
      try {
        const result = statusSchema.parse(
          await this.activeCall(state, 'Execute', { txnId: op.quote.txnId }),
        );
        op.status = result.status === 'quoted' ? 'unknown' : result.status;
        op.txnHash = result.txnHash;
      } catch {
        op.status = 'unknown';
        op.error = 'SUBMISSION_UNCERTAIN';
      }
      await this.writeOperation(op);
      return op;
    });
  }
  private async refresh(op: Operation): Promise<Operation> {
    if (
      op.kind !== 'transfer' ||
      !op.quote ||
      !['submitting', 'pending', 'unknown'].includes(op.status)
    )
      return op;
    const state = await this.load();
    const result = statusSchema.parse(
      await this.activeCall(state, 'TransactionStatus', { txnId: op.quote.txnId }),
    );
    // An ambiguous Execute is never automatically retried, even when status still says quoted.
    op.status = result.status === 'quoted' ? 'unknown' : result.status;
    op.txnHash = result.txnHash;
    await this.writeOperation(op);
    return op;
  }
  getOperation(id: string): Promise<Operation | null> {
    return this.options.executor.run(async () => {
      const op = await this.readOperation(id);
      return op ? this.refresh(op) : null;
    });
  }
  signMessage(id: string, chainId: number, message: string): Promise<Operation> {
    return this.options.executor.run(async () => {
      requireChain(chainId);
      if (!message || new TextEncoder().encode(message).length > 16_384)
        throw new WalletError('INVALID_MESSAGE', 'Messages must contain 1–16,384 UTF-8 bytes.');
      const { operation, hash } = await this.existing(id, 'sign', { chainId, message });
      if (operation) return operation;
      const state = await this.load();
      await this.ensure(state);
      const op: Operation = {
        id,
        kind: 'sign',
        chainId,
        inputHash: hash,
        createdAt: new Date().toISOString(),
        status: 'unknown',
      };
      await this.writeOperation(op);
      const result = signatureSchema.parse(
        await this.activeCall(state, 'SignMessage', {
          network: String(chainId),
          walletId: state.wallet!.id,
          message,
        }),
      );
      const validity = validSchema.parse(
        await this.options.transport.request('IsValidMessageSignature', {
          network: String(chainId),
          networkFamily: 'evm',
          walletAddress: state.wallet!.address,
          message,
          signature: result.signature,
        }),
      );
      if (!validity.isValid)
        throw new WalletError(
          'SIGNATURE_INVALID',
          'WaaS returned a signature that did not verify.',
          502,
        );
      op.signature = result.signature;
      op.verified = true;
      op.status = 'signed';
      await this.writeOperation(op);
      return op;
    });
  }
}
