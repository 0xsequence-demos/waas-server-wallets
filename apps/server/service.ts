import {
  EncryptedStore,
  ServerWallet,
  WalletError,
  WaasTransport,
  type ExclusiveExecutor,
  type StateStore,
  type Operation,
  type Transfer,
  type WalletSnapshot,
} from '@oms/server-wallet-sdk';
import { readiness, scopeFor, type Config } from './config.js';
import { OidcIssuer } from './issuer.js';
import { omsFetch } from './oms-fetch.js';

export type Command =
  | { kind: 'restore' | 'inspect' | 'rotate' | 'disable' | 'enable' }
  | { kind: 'sign'; id: string; chainId: number; message: string }
  | { kind: 'prepare'; id: string; transfer: Transfer }
  | { kind: 'execute' | 'operation'; id: string };
export interface CommandResponse {
  snapshot: WalletSnapshot;
  operation?: Operation | null;
}
export type CommandResult =
  | { ok: true; value: CommandResponse }
  | {
      ok: false;
      code: string;
      message: string;
      status: number;
      diagnostic?: { errorType: string; frames?: string[] };
    };

export async function processCommand(
  config: Config,
  subject: string,
  store: StateStore,
  executor: ExclusiveExecutor,
  command: Command,
): Promise<CommandResult> {
  try {
    const missing = readiness(config);
    if (missing.length)
      throw new WalletError('CONFIGURATION', `Complete setup: ${missing.join(', ')}.`, 503);
    const issuer = new OidcIssuer(config);
    const wallet = new ServerWallet({
      subject,
      issuer: config.OIDC_ISSUER,
      audience: config.OIDC_AUDIENCE,
      tokenProvider: () => issuer.issue(subject),
      store: new EncryptedStore(store, config.ENCRYPTION_KEY, `${scopeFor(config)}:${subject}`),
      executor,
      transport: new WaasTransport(
        config.OMS_PUBLISHABLE_KEY,
        config.TRUSTED_PCR0S.split(',').filter(Boolean),
        omsFetch(config.APP_ORIGIN),
      ),
    });
    let operation: Operation | null | undefined;
    switch (command.kind) {
      case 'restore':
        await wallet.createOrRestore();
        break;
      case 'rotate':
        await wallet.rotate();
        break;
      case 'disable':
        await wallet.setDisabled(true);
        break;
      case 'enable':
        await wallet.setDisabled(false);
        break;
      case 'sign':
        operation = await wallet.signMessage(command.id, command.chainId, command.message);
        break;
      case 'prepare':
        operation = await wallet.prepareTransfer(command.id, command.transfer);
        break;
      case 'execute':
        operation = await wallet.executeTransfer(command.id);
        break;
      case 'operation':
        operation = await wallet.getOperation(command.id);
        break;
    }
    return { ok: true, value: { snapshot: await wallet.inspect(), operation } };
  } catch (error) {
    if (error instanceof WalletError)
      return { ok: false, code: error.code, message: error.message, status: error.status };
    // Never log RPC bodies, tokens, private keys, or upstream error messages.
    const diagnostic = {
      errorType: error instanceof Error ? error.name : typeof error,
      frames: error instanceof Error ? error.stack?.split('\n').slice(1, 6) : undefined,
    };
    return {
      ok: false,
      code: 'WALLET_OPERATION_FAILED',
      message: 'Wallet operation failed. Its upstream outcome may need reconciliation.',
      status: 502,
      diagnostic,
    };
  }
}
