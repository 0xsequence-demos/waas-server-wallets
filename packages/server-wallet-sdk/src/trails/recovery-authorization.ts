import { Payload } from '@0xsequence/wallet-primitives';
import { bytesToHex, decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress } from 'viem';
import { WalletError } from '../errors.js';
import { canonicalJson } from '../json.js';
import type { PreparedRecovery, TrailsIntent } from './protocol.js';
import { callEncodings, decodeCalls } from './codec.js';
import { sweepAbi, validateRecoveryPayload } from './recovery.js';
import { tokenAddress } from './quote.js';

/**
 * Compatibility for the API's non-delegate utility sweep. Sweepable.sol sweeps address(this),
 * not the calling intent. Convert only that exact recognized shape into bounded direct refunds.
 * The original prepared envelope must be retained separately by the host for audit.
 */
export function recoveryAuthorization(
  raw: PreparedRecovery,
  intent: TrailsIntent,
  owner: string,
  balances: readonly { asset: string; amount: string }[],
): PreparedRecovery {
  const validated = validateRecoveryPayload(raw, intent, owner, balances);
  const decoded = decodeCalls(validated.payload.encoded, validated.intentAddress);
  if (
    !decoded.calls.some(
      (call) => call.to.toLowerCase() === intent.trailsContracts.trailsUtilsAddress,
    )
  )
    return structuredClone(raw);
  if (
    decoded.calls.length !== 1 ||
    decoded.calls[0].to.toLowerCase() !== intent.trailsContracts.trailsUtilsAddress
  )
    throw new WalletError('INVALID_RECOVERY', 'Unsupported mixed utility recovery envelope.', 502);
  const { args } = decodeFunctionData({ abi: sweepAbi, data: decoded.calls[0].data });
  const assets = [...args[1].map(tokenAddress), ...(args[2] ? [zeroAddress] : [])];
  const calls: Payload.Call[] = assets.map((asset) => {
    const balance = balances.find((b) => tokenAddress(b.asset) === asset);
    if (!balance || BigInt(balance.amount) <= 0n)
      throw new WalletError(
        'RECOVERY_CHANGED',
        'A reviewed recovery balance is no longer available.',
        409,
      );
    const native = asset === zeroAddress;
    return {
      to: native ? args[0] : asset,
      data: native
        ? '0x'
        : encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [args[0], BigInt(balance.amount)],
          }),
      value: native ? BigInt(balance.amount) : 0n,
      gasLimit: 0n,
      delegateCall: false,
      onlyFallback: false,
      behaviorOnError: 'revert',
    };
  });
  const payload: Payload.Calls = { ...decoded, calls };
  const typedData = {
    ...validated.typedData,
    message: {
      calls: calls.map((c) => ({
        to: c.to,
        value: c.value.toString(),
        data: c.data,
        gasLimit: '0',
        delegateCall: false,
        onlyFallback: false,
        behaviorOnError: '1',
      })),
      space: payload.space.toString(),
      nonce: '0',
      wallets: [],
    },
  };
  const authorization: PreparedRecovery = {
    ...raw,
    payload: { ...raw.payload, encoded: callEncodings(payload)[0] },
    typedData: JSON.parse(canonicalJson(typedData)),
    payloadHash: bytesToHex(Payload.hash(validated.intentAddress, validated.chainId, payload)),
  };
  validateRecoveryPayload(authorization, intent, owner, balances);
  return authorization;
}
