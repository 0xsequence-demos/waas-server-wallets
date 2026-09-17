import { Payload } from '@0xsequence/wallet-primitives';
import {
  bytesToHex,
  hexToBytes,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  zeroAddress,
} from 'viem';
import { WalletError } from '../errors.js';
import { validateTypedData } from '../typed-data.js';
import { canonicalJson } from '../json.js';
import { addressSchema, recoverySchema, uintSchema, type TrailsIntent } from './protocol.js';
import { tokenAddress } from './quote.js';

export const sweepAbi = parseAbi([
  'function sweep(address sweepTarget, address[] tokensToSweep, bool sweepNative)',
]);

/** Validate the authorization before it reaches WaaS. Does not sign or submit it. */
export function validateRecoveryPayload(
  raw: unknown,
  intent: TrailsIntent,
  owner: string,
  balances: readonly { asset: string; amount: string }[],
) {
  try {
    const prepared = recoverySchema.parse(raw);
    const recipient = addressSchema.parse(owner);
    const allowed = new Map(
      balances.map((b) => [tokenAddress(b.asset), BigInt(uintSchema.parse(b.amount))]),
    );
    if (
      recipient === zeroAddress ||
      recipient !== intent.ownerAddress ||
      prepared.intentId !== intent.intentId
    )
      throw new Error('Owner/intent mismatch');
    const target =
      prepared.intentSource === 'origin'
        ? intent.originIntentAddress
        : intent.destinationIntentAddress;
    const chain =
      prepared.intentSource === 'origin' ? intent.originChainId : intent.destinationChainId;
    if (
      !target ||
      prepared.intentAddress !== target ||
      prepared.chainId !== chain ||
      prepared.payload.chainId !== chain ||
      prepared.payload.intentAddress !== target
    )
      throw new Error('Recovery target mismatch');
    const payload = Payload.decode(hexToBytes(prepared.payload.encoded as `0x${string}`), target);
    if (
      payload.calls.length < 1 ||
      payload.calls.length > 64 ||
      payload.space <= 1n ||
      payload.nonce !== 0n
    )
      throw new Error('Unsupported recovery payload');
    // Go omits empty calldata; wallet-primitives 3.0.11 emits an explicit zero
    // length for '0x'. Accept both equivalent encodings, but no trailing bytes.
    const withoutEmptyData = {
      ...payload,
      calls: payload.calls.map((call) => ({
        ...call,
        data: call.data === '0x' ? ('' as `0x${string}`) : call.data,
      })),
    };
    // Go encodes nonce=0 in zero bytes; the TS codec uses one zero byte. Space
    // is nonzero here, so that byte follows the flag and the 20-byte space.
    const tsEncoded = Payload.encode(withoutEmptyData);
    const goEncoded = new Uint8Array(tsEncoded.length - 1);
    goEncoded.set(tsEncoded.subarray(0, 21));
    goEncoded[0] &= ~0x0e;
    goEncoded.set(tsEncoded.subarray(22), 21);
    const encoded = prepared.payload.encoded.toLowerCase();
    if (bytesToHex(Payload.encode(payload)) !== encoded && bytesToHex(goEncoded) !== encoded)
      throw new Error('Noncanonical recovery');
    for (const call of payload.calls) {
      if (
        call.delegateCall ||
        call.onlyFallback ||
        call.behaviorOnError !== 'revert' ||
        call.gasLimit !== 0n
      )
        throw new Error('Unexpected call flags');
      const to = call.to.toLowerCase();
      if (
        call.data === '0x' &&
        to === recipient &&
        call.value > 0n &&
        call.value <= (allowed.get(zeroAddress) ?? 0n)
      ) {
        allowed.set(zeroAddress, allowed.get(zeroAddress)! - call.value);
        continue;
      }
      if (call.value !== 0n || to === zeroAddress) throw new Error('Unexpected call value');
      if (to === intent.trailsContracts.trailsUtilsAddress) {
        const { args } = decodeFunctionData({ abi: sweepAbi, data: call.data });
        if (
          args[0].toLowerCase() !== recipient ||
          args[1].length > 64 ||
          (!args[1].length && !args[2]) ||
          (args[2] && (allowed.get(zeroAddress) ?? 0n) <= 0n) ||
          args[1].some((t) => t === zeroAddress || (allowed.get(tokenAddress(t)) ?? 0n) <= 0n)
        )
          throw new Error('Unexpected sweep');
        if (
          encodeFunctionData({ abi: sweepAbi, functionName: 'sweep', args }).toLowerCase() !==
          call.data.toLowerCase()
        )
          throw new Error('Noncanonical sweep');
        const swept = [...args[1].map(tokenAddress), ...(args[2] ? [zeroAddress] : [])];
        if (new Set(swept).size !== swept.length) throw new Error('Duplicate sweep');
        for (const token of swept) allowed.set(token, 0n);
      } else {
        const parsed = decodeFunctionData({ abi: erc20Abi, data: call.data });
        if (
          parsed.functionName !== 'transfer' ||
          parsed.args[0].toLowerCase() !== recipient ||
          parsed.args[1] <= 0n ||
          parsed.args[1] > (allowed.get(tokenAddress(to)) ?? 0n)
        )
          throw new Error('Unexpected token call');
        if (
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: parsed.args,
          }).toLowerCase() !== call.data.toLowerCase()
        )
          throw new Error('Noncanonical transfer');
        allowed.set(tokenAddress(to), allowed.get(tokenAddress(to))! - parsed.args[1]);
      }
    }
    const expectedHash = bytesToHex(Payload.hash(target, chain, payload));
    const { typedData, digest } = validateTypedData(prepared.typedData, chain);
    if (
      typedData.domain.name !== 'Sequence Wallet' ||
      typedData.domain.version !== '3' ||
      typedData.primaryType !== 'Calls' ||
      typedData.domain.verifyingContract.toLowerCase() !== target ||
      digest !== expectedHash ||
      digest !== prepared.payloadHash.toLowerCase()
    )
      throw new Error('Recovery hash mismatch');
    return {
      ...prepared,
      typedData: JSON.parse(canonicalJson(typedData)) as typeof typedData,
      digest,
    };
  } catch {
    throw new WalletError(
      'INVALID_RECOVERY',
      'Recovery must authorize only transfers to this wallet on the recorded intent chain.',
      502,
    );
  }
}
