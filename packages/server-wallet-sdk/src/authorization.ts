import { WalletError } from './errors.js';

export interface RecoveryTransaction {
  readonly chainId: number;
  readonly owner: string;
  readonly to: string;
  readonly data: string;
  readonly value: '0';
}
const permits = new WeakSet<object>();
/** Internal capability: only the recovery validator may create one. Never deserialize it. */
export function permitRecovery(input: RecoveryTransaction): RecoveryTransaction {
  const permit = Object.freeze({ ...input });
  permits.add(permit);
  return permit;
}
export function requireRecoveryPermit(input: RecoveryTransaction) {
  if (!permits.has(input))
    throw new WalletError(
      'INVALID_RECOVERY',
      'Validate the recovery transaction before preparing it.',
    );
}
