import { SerialExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import {
  WalletSwaps,
  TrailsError,
  type SwapRecord,
  type SwapStore,
  type SwapGateway,
  type ChainReader,
  type TrailsIntent,
  type TrailsReceipt,
  type PreparedRecovery,
} from '@polygonlabs/oms-server-wallet-sdk/trails';
import { encodeFunctionData } from 'viem';
import { executeAbi } from '../packages/server-wallet-sdk/src/trails/recovery-transaction.js';
import { sdkHarness } from './helpers.js';
import {
  quoteFixture,
  recoveryFixture,
  contracts,
  owner,
  originIntent,
  token,
  intentId,
} from './fixtures/trails.js';

export class MemorySwapStore implements SwapStore {
  records = new Map<string, SwapRecord>();
  fail?: (record: SwapRecord) => boolean;
  async get(id: string) {
    return structuredClone(this.records.get(id) ?? null);
  }
  async findIntent(intentId: string) {
    return [...this.records.values()].find((r) => r.quote.intent.intentId === intentId)?.id ?? null;
  }
  async save(record: SwapRecord) {
    if (this.fail?.(record)) throw new Error('Simulated storage outage');
    this.records.set(record.id, structuredClone(record));
  }
  async list({ active, offset = 0, limit }: { active?: boolean; offset?: number; limit: number }) {
    return structuredClone(
      [...this.records.values()]
        .filter((r) => !active || !!r.action)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(offset, offset + limit),
    );
  }
}
export const executeData = (payload: string, signature = '0x1234') =>
  encodeFunctionData({
    abi: executeAbi,
    functionName: 'execute',
    args: [payload as `0x${string}`, signature as `0x${string}`],
  });
export async function swapHarness(native = false) {
  const waas = sdkHarness();
  const original = waas.remote.request.bind(waas.remote);
  waas.remote.request = async (...args) => {
    const result = await original(...args);
    if (args[0] === 'PrepareEthereumTransaction')
      (result as { expiresAt: string }).expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    return result;
  };
  await waas.client.createOrRestore();
  let clock = Date.now();
  const fixture = quoteFixture(native);
  let intent: TrailsIntent = {
    ...fixture.intent,
    expiresAt: new Date(clock + 900_000).toISOString(),
  } as TrailsIntent;
  let receipt: TrailsReceipt = {
    intentId,
    status: 'EXECUTING',
    ownerAddress: owner,
    originChainId: 137,
    destinationChainId: 8453,
    depositTransaction: {
      intentId,
      chainId: 137,
      status: 'PENDING',
      type: 'DEPOSIT',
      fromAddress: owner,
      toAddress: originIntent,
      tokenAddress: intent.originTokenAddress,
      tokenAmount: fixture.input.amount,
      txnHash: `0x${'00'.repeat(32)}`,
    },
    summary: {
      originIntentAddress: originIntent,
      destinationIntentAddress: intent.destinationIntentAddress!,
    },
  };
  const calls: string[] = [];
  const flags = {
    loseActivation: false,
    missingReceipt: false,
    chainFailure: false,
    chainReverted: false,
    deployed: true,
    badBuild: false,
    balance: '100000000000000000000',
    intentBalance: '0',
    recovered: false,
    recoveredAmount: '1000',
  };
  let recovery = recoveryFixture() as PreparedRecovery;
  const gateway: SwapGateway = {
    readiness: async () => {
      calls.push('readiness');
      return { TrailsContracts: contracts };
    },
    quoteIntent: async () => {
      calls.push('quote');
      return { intent: structuredClone(intent) };
    },
    getIntent: async () => {
      calls.push('getIntent');
      return { intent: structuredClone(intent) };
    },
    executeIntent: async () => {
      calls.push('activate');
      intent.status = 'EXECUTING';
      if (flags.loseActivation) throw new Error('lost activation');
      return { intentId, intentStatus: 'EXECUTING' };
    },
    getIntentReceipt: async () => {
      calls.push('receipt');
      if (flags.missingReceipt) throw new TrailsError('GetIntentReceipt', 400, 8000);
      return { intentReceipt: structuredClone(receipt) };
    },
    retryIntent: async () => {
      calls.push('repair');
      receipt.depositTransaction!.status = 'SUCCEEDED';
      intent.status = 'EXECUTING';
      return { intentId, intentStatus: 'EXECUTING' };
    },
    prepareIntentRecovery: async () => {
      calls.push('prepareRecovery');
      return structuredClone(recovery);
    },
    buildIntentRecoveryTransaction: async () => {
      calls.push('buildRecovery');
      return {
        to: flags.badBuild ? owner : recovery.intentAddress,
        data: executeData(recovery.payload.encoded),
        value: '0',
        chainId: recovery.chainId,
        intentAddress: recovery.intentAddress,
        requiresDeploy: false,
        payloadHash: recovery.payloadHash,
      };
    },
  };
  const chains: ChainReader = {
    balance: async (_chain, address, asset) => {
      if (flags.chainFailure) throw new Error('RPC down');
      if (address.toLowerCase() === owner)
        return flags.recovered ? (BigInt(flags.balance) + 1000n).toString() : flags.balance;
      return asset === token || native ? flags.intentBalance : '0';
    },
    code: async () => (flags.deployed ? '0x60006000' : '0x'),
    receipt: async (_chain, hash) => {
      calls.push('chainReceipt');
      if (flags.chainFailure) throw new Error('RPC down');
      return {
        hash,
        status: flags.chainReverted ? 'reverted' : 'success',
        blockNumber: '100',
        transfers: flags.recovered
          ? [
              {
                asset: token,
                from: recovery.intentAddress,
                to: owner,
                amount: flags.recoveredAmount,
              },
            ]
          : [{ asset: token, from: owner, to: originIntent, amount: fixture.input.amount }],
      };
    },
  };
  const store = new MemorySwapStore();
  const workflow = new SerialExecutor();
  const legacyIds: string[] = [];
  const create = (enabled = true, environment = 'default') =>
    new WalletSwaps({
      wallet: waas.create(),
      legacyOperationIds: async () => legacyIds,
      trails: gateway,
      chains,
      store,
      assets: fixture.assets,
      executor: workflow,
      enabled,
      clock: () => clock,
      environment,
    });
  let swaps = create();
  const quote = async (id = 'swap-test-0001') => swaps.quoteSwap(id, fixture.input);
  const confirm = async () => {
    const q = await quote();
    return swaps.confirmSwap(q.id, q.quote.revision);
  };
  const tick = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      clock += 5001;
      await swaps.tick();
    }
  };
  return {
    waas,
    legacyIds,
    fixture,
    flags,
    gateway,
    chains,
    store,
    calls,
    quote,
    confirm,
    tick,
    create,
    get swaps() {
      return swaps;
    },
    restart(enabled = true, environment = 'default') {
      swaps = create(enabled, environment);
    },
    get intent() {
      return intent;
    },
    set intent(v: TrailsIntent) {
      intent = v;
    },
    get receipt() {
      return receipt;
    },
    set receipt(v: TrailsReceipt) {
      receipt = v;
    },
    get recovery() {
      return recovery;
    },
    set recovery(v: PreparedRecovery) {
      recovery = v;
    },
    advance(ms: number) {
      clock += ms;
    },
    record: async () => (await store.get('swap-test-0001'))!,
  };
}
