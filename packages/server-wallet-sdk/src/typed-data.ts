import { hashTypedData } from 'viem';
import { z } from 'zod';
import { WalletError } from './errors.js';
import { requireChain } from './environment.js';
import { canonicalJson } from './json.js';

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v as `0x${string}`);
const schema = z
  .object({
    domain: z
      .object({
        name: z.string().max(256).optional(),
        version: z.string().max(64).optional(),
        chainId: z.union([
          z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .max(16),
          z.number().int().positive().safe(),
        ]),
        verifyingContract: address,
        salt: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/)
          .transform((v) => v as `0x${string}`)
          .optional(),
      })
      .strict(),
    types: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z
        .array(
          z
            .object({
              name: z.string().min(1).max(128),
              type: z.string().min(1).max(128),
            })
            .strict(),
        )
        .max(64),
    ),
    primaryType: z.string().min(1).max(128),
    message: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Require an explicit chain and verifying contract for backend authorizations. */
export function validateTypedData(input: unknown, chainId: number) {
  requireChain(chainId);
  try {
    const data = schema.parse(JSON.parse(canonicalJson(input, 65_536)));
    if (
      BigInt(data.domain.chainId) !== BigInt(chainId) ||
      data.primaryType === 'EIP712Domain' ||
      !data.types[data.primaryType]
    )
      throw new Error('Typed data domain/type mismatch');
    const domainTypes = [
      ...(data.domain.name === undefined ? [] : [{ name: 'name', type: 'string' }]),
      ...(data.domain.version === undefined ? [] : [{ name: 'version', type: 'string' }]),
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      ...(data.domain.salt === undefined ? [] : [{ name: 'salt', type: 'bytes32' }]),
    ];
    if (
      data.types.EIP712Domain &&
      canonicalJson(data.types.EIP712Domain) !== canonicalJson(domainTypes)
    )
      throw new Error('Domain type must bind the selected chain and contract');
    const types: typeof data.types = { ...data.types, EIP712Domain: domainTypes };
    const normalized = { ...data, domain: { ...data.domain, chainId }, types };
    const digest = hashTypedData(normalized);
    return { typedData: normalized, digest };
  } catch {
    throw new WalletError(
      'INVALID_TYPED_DATA',
      'Provide valid bounded EIP-712 data for the selected chain and contract.',
    );
  }
}
