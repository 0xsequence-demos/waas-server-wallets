import { expect, it } from 'vitest';
import { Payload } from '@0xsequence/wallet-primitives';
import { encodeFunctionData, hexToBytes, decodeFunctionData, erc20Abi } from 'viem';
import {
  recoveryAuthorization,
  validateRecoveryPayload,
} from '@polygonlabs/oms-server-wallet-sdk/trails';
import { sweepAbi } from '../packages/server-wallet-sdk/src/trails/recovery.js';
import { intentSchema, recoverySchema } from '../packages/server-wallet-sdk/src/trails/protocol.js';
import {
  contracts,
  owner,
  token,
  quoteFixture,
  recoveryCall,
  recoveryFixture,
} from './fixtures/trails.js';
import { swapHarness, executeData } from './swap-harness.js';

const balances = [
  { asset: token, amount: '1000' },
  { asset: 'native', amount: '2000' },
];
function sweep() {
  return recoverySchema.parse(
    recoveryFixture([
      recoveryCall({
        to: contracts.trailsUtilsAddress,
        data: encodeFunctionData({
          abi: sweepAbi,
          functionName: 'sweep',
          args: [owner, [token], true],
        }),
      }),
    ]),
  );
}
it('converts the known external utility sweep into exact intent-owned ERC20/native refunds', () => {
  const raw = sweep(),
    before = structuredClone(raw),
    intent = intentSchema.parse(quoteFixture().intent);
  const result = recoveryAuthorization(raw, intent, owner, balances);
  expect(raw).toEqual(before);
  expect(result.payloadHash).not.toBe(raw.payloadHash);
  const original = Payload.decode(
    hexToBytes(raw.payload.encoded as `0x${string}`),
    raw.intentAddress,
  );
  const payload = Payload.decode(
    hexToBytes(result.payload.encoded as `0x${string}`),
    result.intentAddress,
  );
  expect(payload.space).toBe(original.space);
  expect(payload.nonce).toBe(0n);
  expect(payload.calls).toHaveLength(2);
  expect(payload.calls[0]).toMatchObject({ to: token, value: 0n, delegateCall: false });
  expect(decodeFunctionData({ abi: erc20Abi, data: payload.calls[0].data })).toMatchObject({
    functionName: 'transfer',
    args: [owner, 1000n],
  });
  expect(payload.calls[1]).toMatchObject({
    to: owner,
    value: 2000n,
    data: '0x',
    delegateCall: false,
  });
  expect(validateRecoveryPayload(result, intent, owner, balances).digest).toBe(result.payloadHash);
});
it('leaves direct envelopes unchanged and rejects unknown delegates, recipients and mixed sweep calls', () => {
  const intent = intentSchema.parse(quoteFixture().intent),
    direct = recoverySchema.parse(recoveryFixture());
  expect(recoveryAuthorization(direct, intent, owner, balances)).toEqual(direct);
  const bad = recoverySchema.parse(
    recoveryFixture([
      recoveryCall({
        to: contracts.trailsUtilsAddress,
        delegateCall: true,
        data: encodeFunctionData({
          abi: sweepAbi,
          functionName: 'sweep',
          args: [owner, [token], false],
        }),
      }),
    ]),
  );
  expect(() => recoveryAuthorization(bad, intent, owner, balances)).toThrow();
  const mixed = recoverySchema.parse(
    recoveryFixture([
      recoveryCall(),
      recoveryCall({
        to: contracts.trailsUtilsAddress,
        data: encodeFunctionData({ abi: sweepAbi, functionName: 'sweep', args: [owner, [], true] }),
      }),
    ]),
  );
  expect(() => recoveryAuthorization(mixed, intent, owner, balances)).toThrow('Unsupported mixed');
});
it('journals the original envelope and signs/builds only the reviewed direct refund authorization', async () => {
  const h = await swapHarness();
  await h.confirm();
  await h.tick(4);
  h.waas.remote.txnStatus = 'executed';
  await h.tick();
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  const raw = recoverySchema.parse(
    recoveryFixture([
      recoveryCall({
        to: contracts.trailsUtilsAddress,
        data: encodeFunctionData({
          abi: sweepAbi,
          functionName: 'sweep',
          args: [owner, [token], false],
        }),
      }),
    ]),
  );
  h.recovery = raw;
  const view = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-sweep-01', 'origin');
  const record = await h.record();
  expect(record.recoveries[0].originalPrepared).toEqual(raw);
  expect(record.recoveries[0].prepared.payloadHash).not.toBe(raw.payloadHash);
  h.gateway.buildIntentRecoveryTransaction = async (prepared) => ({
    to: prepared.intentAddress,
    data: executeData(prepared.payload.encoded),
    value: '0',
    chainId: prepared.chainId,
    intentAddress: prepared.intentAddress,
    requiresDeploy: false,
    payloadHash: prepared.payloadHash,
  });
  await h.swaps.confirmRecovery(view.id, 'recovery-sweep-01', view.recoveries[0].revision);
  await h.tick(3);
  h.waas.remote.txnStatus = 'executed';
  h.flags.recovered = true;
  h.flags.intentBalance = '0';
  await h.tick();
  expect((await h.record()).recoveries[0].status).toBe('recovered');
});
