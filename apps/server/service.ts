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
} from '@polygonlabs/oms-server-wallet-sdk';
import { readiness, scopeFor, type Config } from './config.js';
import { OidcIssuer } from './issuer.js';
import { omsFetch } from './oms-fetch.js';
import {
  EvmChainReader,
  WalletSwaps,
  type SwapStore,
  type SwapView,
  type SwapRequest,
} from '@polygonlabs/oms-server-wallet-sdk/trails';
import {
  SWAP_ASSETS,
  discoverSwapAssets,
  rpcUrls,
  trailsClient,
  trailsEnvironment,
} from './swaps-config.js';

export type Command =
  | { kind: 'restore' | 'inspect' | 'rotate' | 'disable' | 'enable' }
  | { kind: 'sign'; id: string; chainId: number; message: string }
  | { kind: 'prepare'; id: string; transfer: Transfer }
  | { kind: 'execute' | 'operation'; id: string }
  | { kind: 'swap-quote'; id: string; request: SwapRequest }
  | { kind: 'swap-confirm'; id: string; revision: string }
  | { kind: 'swap-get' | 'swap-reconcile'; id: string }
  | { kind: 'swap-list'; offset: number }
  | { kind: 'swap-tick' }
  | { kind: 'recovery-quote'; id: string; recoveryId: string; source: 'origin' | 'destination' }
  | { kind: 'recovery-confirm'; id: string; recoveryId: string; revision: string };
export interface CommandResponse {
  snapshot: WalletSnapshot;
  operation?: Operation | null;
  swap?: SwapView;
  swaps?: SwapView[];
}
export interface SwapHost {
  store: SwapStore;
  executor: ExclusiveExecutor;
  legacyOperationIds?: () => Promise<string[]>;
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
  host?: SwapHost,
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
    let swap: SwapView | undefined;
    let list: SwapView[] | undefined;
    // Optional configuration must not prevent login, lifecycle operations or ordinary transfers.
    const isSwap = command.kind.startsWith('swap-') || command.kind.startsWith('recovery-');
    let trails: ReturnType<typeof trailsClient>;
    try {
      trails = trailsClient(config);
    } catch (error) {
      if (isSwap) throw error;
    }
    const chainReader = () => new EvmChainReader(rpcUrls(config));
    const swaps = host
      ? new WalletSwaps({
          wallet,
          ...host,
          legacyOperationIds: host.legacyOperationIds,
          trails,
          enabled: config.SWAPS_ENABLED === 'true',
          environment: trailsEnvironment(config),
          assets:
            command.kind === 'swap-quote' && trails
              ? await discoverSwapAssets(trails)
              : SWAP_ASSETS,
          chains: {
            balance: (...args) => chainReader().balance(...args),
            code: (...args) => chainReader().code(...args),
            receipt: (...args) => chainReader().receipt(...args),
          },
        })
      : undefined;
    if (isSwap && !swaps)
      throw new WalletError('SWAPS_UNAVAILABLE', 'Persistent swap storage is not configured.', 503);
    const coordinated = <T>(task: () => Promise<T>) => (swaps ? swaps.walletCommand(task) : task());
    switch (command.kind) {
      case 'restore':
        await coordinated(() => wallet.createOrRestore());
        break;
      case 'rotate':
        await coordinated(() => wallet.rotate());
        break;
      case 'disable':
        await coordinated(() => wallet.setDisabled(true));
        break;
      case 'enable':
        await coordinated(() => wallet.setDisabled(false));
        break;
      case 'sign':
        operation = await coordinated(() =>
          wallet.signMessage(command.id, command.chainId, command.message),
        );
        break;
      case 'prepare':
        operation = await (swaps ?? wallet).prepareTransfer(command.id, command.transfer);
        break;
      case 'execute':
        operation = await (swaps ?? wallet).executeTransfer(command.id);
        break;
      case 'operation':
        operation = await coordinated(() => wallet.getOperation(command.id));
        break;
      case 'swap-quote':
        swap = await swaps!.quoteSwap(command.id, command.request);
        break;
      case 'swap-confirm':
        swap = await swaps!.confirmSwap(command.id, command.revision);
        break;
      case 'swap-get':
        swap = await swaps!.getSwap(command.id);
        break;
      case 'swap-reconcile':
        swap = await swaps!.reconcileSwap(command.id);
        break;
      case 'swap-list':
        list = await swaps!.listSwaps(command.offset);
        break;
      case 'swap-tick':
        await swaps!.tick();
        break;
      case 'recovery-quote':
        swap = await swaps!.prepareRecovery(command.id, command.recoveryId, command.source);
        break;
      case 'recovery-confirm':
        swap = await swaps!.confirmRecovery(command.id, command.recoveryId, command.revision);
        break;
    }
    return { ok: true, value: { snapshot: await wallet.inspect(), operation, swap, swaps: list } };
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
