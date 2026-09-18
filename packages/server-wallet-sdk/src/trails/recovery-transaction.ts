import { Address, Context, Payload } from '@0xsequence/wallet-primitives';
import { bytesToHex, decodeFunctionData, encodeFunctionData, hexToBytes, parseAbi } from 'viem';
import { permitRecovery } from '../authorization.js';
import { WalletError } from '../errors.js';
import { builtRecoverySchema, type TrailsIntent } from './protocol.js';
import { validateRecoveryPayload } from './recovery.js';
import { decodeCalls } from './codec.js';

// Pinned to trails-api's go-sequence v0.64.6 V3SequenceContext (RC5).
export const recoveryContext = {
  ...Context.Rc5,
  guest: '0x0000000000006ac72ed1d192fa28f0058d3f8806' as `0x${string}`,
};
export const executeAbi = parseAbi(['function execute(bytes payload, bytes signature)']);
export const deployAbi = parseAbi([
  'function deploy(address implementation, bytes32 imageHash) returns (address)',
]);

/** Turns a validated response into an in-process capability accepted by ServerWallet. */
export function validateRecoveryTransaction(
  raw: unknown,
  prepared: unknown,
  intent: TrailsIntent,
  owner: string,
  balances: readonly { asset: string; amount: string }[],
) {
  try {
    const authorization = validateRecoveryPayload(prepared, intent, owner, balances);
    const transaction = builtRecoverySchema.parse(raw);
    if (
      transaction.chainId !== authorization.chainId ||
      transaction.intentAddress !== authorization.intentAddress ||
      transaction.payloadHash.toLowerCase() !== authorization.digest
    )
      throw new Error('Transaction mismatch');
    let execution = transaction.data as `0x${string}`;
    if (transaction.requiresDeploy) {
      if (transaction.to !== recoveryContext.guest) throw new Error('Unknown guest');
      const guest = decodeCalls(transaction.data, recoveryContext.guest);
      if (
        guest.space !== 0n ||
        guest.nonce !== 0n ||
        guest.calls.length !== 2 ||
        guest.calls.some(
          (c) =>
            c.value !== 0n ||
            c.gasLimit !== 0n ||
            c.delegateCall ||
            c.onlyFallback ||
            c.behaviorOnError !== 'revert',
        )
      )
        throw new Error('Unexpected deployment batch');
      const [deploy, execute] = guest.calls;
      if (
        deploy.to.toLowerCase() !== recoveryContext.factory.toLowerCase() ||
        execute.to.toLowerCase() !== authorization.intentAddress
      )
        throw new Error('Unexpected deployment targets');
      const { args } = decodeFunctionData({ abi: deployAbi, data: deploy.data });
      if (
        args[0].toLowerCase() !== recoveryContext.stage1.toLowerCase() ||
        Address.from(hexToBytes(args[1]), recoveryContext).toLowerCase() !==
          authorization.intentAddress ||
        encodeFunctionData({ abi: deployAbi, functionName: 'deploy', args }).toLowerCase() !==
          deploy.data.toLowerCase()
      )
        throw new Error('Invalid factory deployment');
      execution = execute.data;
    } else if (transaction.to !== authorization.intentAddress)
      throw new Error('Wrong intent executor');
    const { args } = decodeFunctionData({ abi: executeAbi, data: execution });
    if (
      args[1] === '0x' ||
      args[1].length > 131_074 ||
      encodeFunctionData({ abi: executeAbi, functionName: 'execute', args }).toLowerCase() !==
        execution.toLowerCase()
    )
      throw new Error('Invalid execute encoding');
    const calls = decodeCalls(args[0], authorization.intentAddress);
    if (
      bytesToHex(Payload.hash(authorization.intentAddress, authorization.chainId, calls)) !==
      authorization.digest
    )
      throw new Error('Changed signed payload');
    return permitRecovery({
      chainId: transaction.chainId,
      owner: owner.toLowerCase(),
      to: transaction.to,
      data: transaction.data,
      value: '0',
    });
  } catch {
    throw new WalletError(
      'INVALID_RECOVERY_TRANSACTION',
      'Recovery execution does not match the reviewed authorization and supported wallet contracts.',
      502,
    );
  }
}
