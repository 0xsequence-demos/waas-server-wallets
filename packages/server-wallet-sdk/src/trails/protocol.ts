import { z } from 'zod';

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const hexSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .max(131_074);
export const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(78)
  .refine((v) => BigInt(v) < 2n ** 256n);
export const chainSchema = z.number().int().positive().safe();
export const statusSchema = z.enum([
  'QUOTED',
  'COMMITTED',
  'EXECUTING',
  'FAILED',
  'SUCCEEDED',
  'ABORTED',
  'REFUNDED',
  'INVALID',
]);
const usd = z.number().finite().nonnegative();
export const contractsSchema = z
  .object({
    // v1.5 leaves the three legacy v1 addresses empty.
    trailsIntentEntrypointAddress: z.union([addressSchema, z.literal('')]),
    trailsRouterAddress: z.union([addressSchema, z.literal('')]),
    trailsRouterShimAddress: z.union([addressSchema, z.literal('')]),
    trailsUtilsAddress: addressSchema,
  })
  .passthrough();
export const tokenSchema = z
  .object({
    chainId: chainSchema,
    address: addressSchema,
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int().min(0).max(255),
    feeOnTransfer: z.boolean().optional(),
  })
  .passthrough();
export const chainInfoSchema = z
  .object({
    id: chainSchema,
    name: z.string(),
    nativeCurrency: z.object({
      name: z.string(),
      symbol: z.string(),
      decimals: z.number().int().min(0).max(255),
    }),
  })
  .passthrough();
export const depositSchema = z
  .object({
    toAddress: addressSchema,
    tokenAddress: addressSchema,
    amount: uintSchema,
    chainId: chainSchema,
    to: addressSchema,
    data: hexSchema,
    value: uintSchema,
    decimals: z.number().int().min(0).max(255).nullish(),
  })
  .passthrough();
export const intentSchema = z
  .object({
    intentId: hashSchema,
    status: statusSchema,
    ownerAddress: addressSchema,
    originChainId: chainSchema,
    destinationChainId: chainSchema,
    originTokenAddress: addressSchema,
    destinationTokenAddress: addressSchema,
    originIntentAddress: addressSchema,
    destinationIntentAddress: addressSchema.nullish(),
    quoteRequest: z.record(z.string(), z.unknown()),
    intentProtocol: z.literal('v1.5'),
    expiresAt: z.string().datetime({ offset: true }),
    isTestnet: z.boolean(),
    passthrough: z.boolean().nullish(),
    depositTransaction: depositSchema,
    trailsContracts: contractsSchema,
    originPrecondition: z
      .object({
        type: z.literal('tokenMinBalance'),
        chainId: chainSchema,
        ownerAddress: addressSchema,
        tokenAddress: addressSchema,
        minAmount: uintSchema,
      })
      .passthrough(),
    quote: z
      .object({
        fromAmount: uintSchema,
        fromAmountMin: uintSchema,
        toAmount: uintSchema,
        toAmountMin: uintSchema,
        routeProviders: z.array(z.string().min(1)).min(1).max(32),
        estimatedDuration: z.number().finite().nonnegative().nullish(),
        maxSlippage: z.number().finite().min(0).max(1),
        priceImpact: z.number().finite(),
      })
      .passthrough(),
    fees: z
      .object({ totalFeeUsd: usd, gasFeeUsd: usd, trailsFeeUsd: usd, providerFeeUsd: usd })
      .passthrough(),
  })
  .passthrough();
export const recoverySchema = z
  .object({
    intentId: hashSchema,
    intentProtocol: z.literal('v1.5'),
    intentAddress: addressSchema,
    chainId: chainSchema,
    intentSource: z.enum(['origin', 'destination']),
    payload: z
      .object({
        kind: z.literal('v3_calls_payload'),
        encoding: z.literal('hex'),
        encoded: hexSchema,
        intentAddress: addressSchema,
        chainId: chainSchema,
      })
      .strict(),
    typedData: z.unknown(),
    payloadHash: hashSchema,
  })
  .passthrough();
export type TrailsIntent = z.infer<typeof intentSchema>;
export type TrailsToken = z.infer<typeof tokenSchema>;
export type TrailsContracts = z.infer<typeof contractsSchema>;
export type PreparedRecovery = z.infer<typeof recoverySchema>;

export const transactionStatusSchema = z.enum([
  'UNKNOWN',
  'ON_HOLD',
  'PENDING',
  'RELAYING',
  'SENT',
  'ERRORED',
  'MINING',
  'SUCCEEDED',
  'FAILED',
  'ABORTED',
  'REVERTED',
]);
export const intentTransactionSchema = z
  .object({
    intentId: hashSchema,
    status: transactionStatusSchema,
    chainId: chainSchema,
    type: z.enum(['UNKNOWN', 'DEPOSIT', 'ORIGIN', 'DESTINATION', 'ROUTE', 'REFUND']),
    fromAddress: addressSchema,
    toAddress: addressSchema,
    tokenAddress: addressSchema,
    tokenAmount: uintSchema,
    txnHash: z.union([hashSchema, z.literal('')]).nullish(),
  })
  .passthrough();
export const receiptSchema = z
  .object({
    intentId: hashSchema,
    status: statusSchema,
    ownerAddress: addressSchema,
    originChainId: chainSchema,
    destinationChainId: chainSchema,
    depositTransaction: intentTransactionSchema.nullish(),
    originTransaction: intentTransactionSchema.nullish(),
    destinationTransaction: intentTransactionSchema.nullish(),
    refundTransaction: intentTransactionSchema.nullish(),
    summary: z
      .object({
        originIntentAddress: addressSchema,
        destinationIntentAddress: addressSchema,
        destinationToAddress: z.union([addressSchema, z.literal('')]).nullish(),
        destinationTokenAddress: z.union([addressSchema, z.literal('')]).nullish(),
        destinationTokenAmount: uintSchema.nullish(),
      })
      .passthrough(),
  })
  .passthrough();
export type TrailsReceipt = z.infer<typeof receiptSchema>;
export const recoveryTokenSchema = z
  .object({
    contractAddress: addressSchema,
    balance: uintSchema,
    chainId: z.number().int().nonnegative().safe(),
    decimals: z.number().int().min(0).max(255),
    symbol: z.string().max(128),
  })
  .passthrough();
export const builtRecoverySchema = z
  .object({
    to: addressSchema,
    data: hexSchema,
    value: z.literal('0'),
    chainId: chainSchema,
    intentAddress: addressSchema,
    requiresDeploy: z.boolean(),
    payloadHash: hashSchema,
  })
  .passthrough();
export type BuiltRecovery = z.infer<typeof builtRecoverySchema>;
