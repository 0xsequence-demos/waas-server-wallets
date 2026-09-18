import { encodeFunctionData, erc20Abi, zeroAddress } from 'viem';
import { z } from 'zod';
import { requireChain } from '../environment.js';
import { WalletError } from '../errors.js';
import { sha256 } from '../encoding.js';
import { canonicalJson } from '../json.js';
import type { Transfer } from '../client.js';
import {
  addressSchema,
  chainSchema,
  contractsSchema,
  intentSchema,
  uintSchema,
  type TrailsContracts,
} from './protocol.js';

const nativeAlias = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export function tokenAddress(asset: string): `0x${string}` {
  return asset === 'native' || asset.toLowerCase() === nativeAlias
    ? zeroAddress
    : addressSchema.parse(asset);
}
export interface SwapAsset {
  chainId: number;
  asset: string;
  decimals: number;
  symbol?: string;
}
export interface SwapRequest {
  originChainId: number;
  originAsset: string;
  destinationChainId: number;
  destinationAsset: string;
  amount: string;
  slippageBps?: 10 | 50 | 100;
}
const inputSchema = z
  .object({
    originChainId: chainSchema,
    originAsset: z.string(),
    destinationChainId: chainSchema,
    destinationAsset: z.string(),
    amount: uintSchema.refine((v) => BigInt(v) > 0n),
    slippageBps: z.union([z.literal(10), z.literal(50), z.literal(100)]).default(50),
  })
  .strict();

/** Assets must come from host policy, never from the dashboard request itself. */
export function buildSwapRequest(owner: string, input: SwapRequest, assets: readonly SwapAsset[]) {
  try {
    const request = inputSchema.parse(input);
    requireChain(request.originChainId);
    requireChain(request.destinationChainId);
    const ownerAddress = addressSchema.parse(owner);
    if (ownerAddress === zeroAddress) throw new Error('Owner required');
    const originTokenAddress = tokenAddress(request.originAsset);
    const destinationTokenAddress = tokenAddress(request.destinationAsset);
    if (
      request.originChainId === request.destinationChainId &&
      originTokenAddress === destinationTokenAddress
    )
      throw new Error('No-op');
    for (const [chainId, token] of [
      [request.originChainId, originTokenAddress],
      [request.destinationChainId, destinationTokenAddress],
    ] as const) {
      if (
        !assets.some(
          (asset) =>
            asset.chainId === chainId &&
            tokenAddress(asset.asset) === token &&
            Number.isInteger(asset.decimals) &&
            asset.decimals >= 0 &&
            asset.decimals <= 255,
        )
      )
        throw new Error('Unsupported asset');
    }
    return {
      ownerAddress,
      originChainId: request.originChainId,
      originTokenAddress,
      originTokenAmount: request.amount,
      destinationChainId: request.destinationChainId,
      destinationTokenAddress,
      destinationToAddress: ownerAddress,
      tradeType: 'EXACT_INPUT' as const,
      fundMethod: 'WALLET' as const,
      mode: 'SWAP' as const,
      onlyNativeGasFee: true,
      options: { intentProtocol: 'v1.5' as const, slippageTolerance: request.slippageBps / 10_000 },
    };
  } catch {
    throw new WalletError(
      'INVALID_SWAP',
      'Select supported assets, distinct sides, a positive base-unit amount and allowed slippage.',
    );
  }
}

export type SwapQuoteRequest = ReturnType<typeof buildSwapRequest>;
export type SwapQuote = Awaited<ReturnType<typeof validateSwapQuote>>;

/** No wallet mutation. A coordinator must persist/review this snapshot before funding. */
export async function validateSwapQuote(
  raw: unknown,
  request: SwapQuoteRequest,
  contracts: TrailsContracts,
  now = Date.now(),
) {
  try {
    const intent = intentSchema.parse(raw);
    const expectedContracts = contractsSchema.parse(contracts);
    const q = intent.quoteRequest;
    if (
      intent.status !== 'QUOTED' ||
      intent.passthrough ||
      intent.isTestnet ||
      Date.parse(intent.expiresAt) <= now + 30_000
    )
      throw new Error('Quote unusable');
    if (
      intent.intentId === `0x${'0'.repeat(64)}` ||
      intent.originIntentAddress === zeroAddress ||
      intent.originIntentAddress === request.ownerAddress
    )
      throw new Error('Invalid intent');
    for (const key of [
      'ownerAddress',
      'originChainId',
      'destinationChainId',
      'originTokenAddress',
      'destinationTokenAddress',
    ] as const) {
      const actual = key.includes('Address') ? tokenAddress(String(intent[key])) : intent[key];
      if (actual !== request[key]) throw new Error('Intent mismatch');
    }
    for (const [key, expected] of Object.entries(request)) {
      if (key === 'options') continue;
      // The API omits this gas-option hint from the stored request. Funding still
      // goes through the host's mandatory WaaS sponsorship check.
      if (key === 'onlyNativeGasFee' && q[key] === undefined) continue;
      const actual = key.endsWith('Address') ? tokenAddress(String(q[key])) : q[key];
      if (actual !== expected) throw new Error('Request mismatch');
    }
    const options = z
      .object({
        intentProtocol: z.literal('v1.5'),
        slippageTolerance: z.number(),
        trailsAddressOverrides: z.never().optional(),
      })
      .passthrough()
      .parse(q.options);
    if (
      options.slippageTolerance !== request.options.slippageTolerance ||
      q.settlement != null ||
      q.destinationTokenAmount != null ||
      (q.destinationCallData != null &&
        q.destinationCallData !== '' &&
        q.destinationCallData !== '0x') ||
      (q.destinationCallValue != null && q.destinationCallValue !== '0') ||
      (q.destinationApproveAddress != null &&
        q.destinationApproveAddress !== '' &&
        q.destinationApproveAddress !== zeroAddress)
    )
      throw new Error('Unexpected execution fields');
    for (const key of [
      'trailsIntentEntrypointAddress',
      'trailsRouterAddress',
      'trailsRouterShimAddress',
      'trailsUtilsAddress',
    ] as const)
      if (
        intent.trailsContracts[key] !== expectedContracts[key] ||
        (key === 'trailsUtilsAddress' && expectedContracts[key] === zeroAddress)
      )
        throw new Error('Contract context mismatch');
    const deposit = intent.depositTransaction;
    const precondition = intent.originPrecondition;
    if (
      deposit.chainId !== request.originChainId ||
      tokenAddress(deposit.tokenAddress) !== request.originTokenAddress ||
      deposit.toAddress !== intent.originIntentAddress ||
      deposit.amount !== request.originTokenAmount ||
      precondition.chainId !== deposit.chainId ||
      precondition.ownerAddress !== deposit.toAddress ||
      tokenAddress(precondition.tokenAddress) !== request.originTokenAddress ||
      precondition.minAmount !== deposit.amount
    )
      throw new Error('Funding mismatch');
    const native = request.originTokenAddress === zeroAddress;
    const expectedData = native
      ? '0x'
      : encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [deposit.toAddress, BigInt(deposit.amount)],
        });
    if (
      deposit.to !== (native ? deposit.toAddress : request.originTokenAddress) ||
      deposit.value !== (native ? deposit.amount : '0') ||
      deposit.data.toLowerCase() !== expectedData
    )
      throw new Error('Unexpected funding calldata');
    const minimum = BigInt(intent.quote.toAmountMin);
    const output = BigInt(intent.quote.toAmount);
    const slippageBps = BigInt(Math.round(request.options.slippageTolerance * 10_000));
    if (
      minimum <= 0n ||
      minimum > output ||
      minimum < (output * (10_000n - slippageBps)) / 10_000n ||
      BigInt(intent.quote.fromAmount) <= 0n ||
      BigInt(intent.quote.fromAmountMin) > BigInt(intent.quote.fromAmount) ||
      BigInt(intent.quote.fromAmount) > BigInt(request.originTokenAmount) ||
      intent.quote.maxSlippage > request.options.slippageTolerance + Number.EPSILON
    )
      throw new Error('Quote amounts/slippage');
    const funding: Transfer = {
      chainId: deposit.chainId,
      to: deposit.toAddress,
      asset: native ? 'native' : request.originTokenAddress,
      amount: deposit.amount,
    };
    const snapshot = JSON.parse(canonicalJson(intent)) as typeof intent;
    return {
      intent: snapshot,
      funding,
      digest: await sha256(canonicalJson({ request, intent: snapshot })),
      expiresAt: intent.expiresAt,
    };
  } catch {
    throw new WalletError(
      'INVALID_SWAP_QUOTE',
      'Trails quote does not match the authorized swap or supported funding contract.',
      502,
    );
  }
}
