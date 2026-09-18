// Synthetic vectors model the pinned RIDL and handle_recovery.go in docs/SWAPS.md.
// Encoding is assembled independently of wallet-primitives to catch codec drift.
import { buildSwapRequest } from '../../packages/server-wallet-sdk/src/trails/quote.js';
import { validateTypedData } from '../../packages/server-wallet-sdk/src/typed-data.js';

export const owner = `0x${'11'.repeat(20)}` as `0x${string}`;
export const originIntent = `0x${'22'.repeat(20)}` as `0x${string}`;
export const destinationIntent = `0x${'33'.repeat(20)}` as `0x${string}`;
export const token = `0x${'44'.repeat(20)}` as `0x${string}`;
export const destinationToken = `0x${'55'.repeat(20)}` as `0x${string}`;
export const zero = `0x${'00'.repeat(20)}` as `0x${string}`;
export const intentId = `0x${'ab'.repeat(32)}`;
export const now = Date.parse('2026-09-17T12:00:00Z');
export const contracts = {
  trailsIntentEntrypointAddress: '' as const,
  trailsRouterAddress: '' as const,
  trailsRouterShimAddress: '' as const,
  trailsUtilsAddress: `0x${'66'.repeat(20)}` as `0x${string}`,
};
export const word = (value: string | bigint) =>
  (typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0');
export const transferData = (recipient: string, amount: string) =>
  `0xa9059cbb${word(recipient)}${word(BigInt(amount))}`;

export function quoteFixture(native = false, amount = '10000000') {
  const assets = [
    { chainId: 137, asset: native ? 'native' : token, decimals: native ? 18 : 6 },
    { chainId: 8453, asset: destinationToken, decimals: 6 },
  ];
  const input = {
    originChainId: 137,
    originAsset: assets[0].asset,
    destinationChainId: 8453,
    destinationAsset: destinationToken,
    amount,
  };
  const request = buildSwapRequest(owner, input, assets);
  const quoteRequest: Record<string, unknown> = {
    ...request,
    options: { ...request.options },
    destinationApproveAddress: '',
    destinationCallData: null,
    destinationCallValue: null,
  };
  delete quoteRequest.onlyNativeGasFee;
  return {
    assets,
    input,
    request,
    intent: {
      intentId,
      status: 'QUOTED' as const,
      ownerAddress: owner,
      originChainId: 137,
      destinationChainId: 8453,
      originTokenAddress: native ? zero : token,
      destinationTokenAddress: destinationToken,
      originIntentAddress: originIntent,
      destinationIntentAddress: destinationIntent,
      quoteRequest,
      intentProtocol: 'v1.5' as const,
      expiresAt: new Date(now + 900_000).toISOString(),
      isTestnet: false,
      passthrough: null,
      depositTransaction: {
        toAddress: originIntent,
        tokenAddress: native ? zero : token,
        amount,
        chainId: 137,
        to: native ? originIntent : token,
        data: native ? '0x' : transferData(originIntent, amount),
        value: native ? amount : '0',
      },
      trailsContracts: { ...contracts },
      originPrecondition: {
        type: 'tokenMinBalance' as const,
        chainId: 137,
        ownerAddress: originIntent,
        tokenAddress: native ? zero : token,
        minAmount: amount,
      },
      quote: {
        fromAmount: amount,
        fromAmountMin: amount,
        toAmount: '9900000',
        toAmountMin: '9850500',
        routeProviders: ['CCTP'],
        estimatedDuration: 8,
        maxSlippage: 0.005,
        priceImpact: 0.1,
      },
      fees: { totalFeeUsd: 0.01, gasFeeUsd: 0.01, trailsFeeUsd: 0, providerFeeUsd: 0 },
    },
  };
}

export interface RecoveryCall {
  to: string;
  value: string;
  data: string;
  gasLimit: string;
  delegateCall: boolean;
  onlyFallback: boolean;
  behaviorOnError: string;
}
export const recoveryCall = (changes: Partial<RecoveryCall> = {}): RecoveryCall => ({
  to: token,
  value: '0',
  data: transferData(owner, '1000'),
  gasLimit: '0',
  delegateCall: false,
  onlyFallback: false,
  behaviorOnError: '1',
  ...changes,
});

export function recoveryFixture(
  calls = [recoveryCall()],
  source: 'origin' | 'destination' = 'origin',
) {
  const intentAddress = source === 'origin' ? originIntent : destinationIntent;
  const chainId = source === 'origin' ? 137 : 8453;
  const typedData = {
    domain: { name: 'Sequence Wallet', version: '3', chainId, verifyingContract: intentAddress },
    types: {
      Calls: [
        { name: 'calls', type: 'Call[]' },
        { name: 'space', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'wallets', type: 'address[]' },
      ],
      Call: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'gasLimit', type: 'uint256' },
        { name: 'delegateCall', type: 'bool' },
        { name: 'onlyFallback', type: 'bool' },
        { name: 'behaviorOnError', type: 'uint256' },
      ],
    },
    primaryType: 'Calls',
    message: { calls, space: '123456789', nonce: '0', wallets: [] as string[] },
  };
  const globalFlag = calls.length === 1 ? '10' : '00';
  let encoded = `0x${globalFlag}${BigInt(typedData.message.space).toString(16).padStart(40, '0')}${calls.length === 1 ? '' : calls.length.toString(16).padStart(2, '0')}`;
  for (const c of calls) {
    const value = BigInt(c.value),
      gas = BigInt(c.gasLimit),
      data = c.data.slice(2);
    const flags =
      (value ? 2 : 0) |
      (data.length ? 4 : 0) |
      (gas ? 8 : 0) |
      (c.delegateCall ? 16 : 0) |
      (c.onlyFallback ? 32 : 0) |
      (Number(c.behaviorOnError) << 6);
    encoded +=
      flags.toString(16).padStart(2, '0') +
      c.to.slice(2) +
      (value ? word(value) : '') +
      (data.length ? (data.length / 2).toString(16).padStart(6, '0') + data : '') +
      (gas ? word(gas) : '');
  }
  return {
    intentId,
    intentProtocol: 'v1.5',
    intentAddress,
    chainId,
    intentSource: source,
    payload: { kind: 'v3_calls_payload', encoding: 'hex', encoded, intentAddress, chainId },
    typedData,
    payloadHash: validateTypedData(typedData, chainId).digest,
  };
}
