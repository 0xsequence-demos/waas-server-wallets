import { expect, it } from 'vitest';
import { Address, Payload } from '@0xsequence/wallet-primitives';
import { bytesToHex, encodeFunctionData, hexToBytes } from 'viem';
import { validateRecoveryTransaction } from '@polygonlabs/oms-server-wallet-sdk/trails';
import {
  recoveryContext,
  deployAbi,
} from '../packages/server-wallet-sdk/src/trails/recovery-transaction.js';
import { intentSchema } from '../packages/server-wallet-sdk/src/trails/protocol.js';
import { validateTypedData } from '../packages/server-wallet-sdk/src/typed-data.js';
import { owner, token, quoteFixture, recoveryFixture } from './fixtures/trails.js';
import { executeData } from './swap-harness.js';
import { sdkHarness } from './helpers.js';

const balances = [{ asset: token, amount: '1000' }];
function built() {
  const prepared = recoveryFixture();
  return {
    prepared,
    intent: intentSchema.parse(quoteFixture().intent),
    tx: {
      to: prepared.intentAddress,
      data: executeData(prepared.payload.encoded),
      value: '0',
      chainId: 137,
      intentAddress: prepared.intentAddress,
      payloadHash: prepared.payloadHash,
      requiresDeploy: false,
    },
  };
}
it('validates an intent execute envelope and grants a non-forgeable zero-value capability', async () => {
  const { prepared, intent, tx } = built();
  const capability = validateRecoveryTransaction(tx, prepared, intent, owner, balances);
  expect(Object.isFrozen(capability)).toBe(true);
  const h = sdkHarness();
  await h.client.createOrRestore();
  const operation = await h.client.prepareRecoveryTransaction('recovery-test', capability);
  expect(operation.kind).toBe('recovery');
  expect(h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')?.body).toMatchObject(
    { to: tx.to, data: tx.data, value: '0', mode: 'relayer' },
  );
  expect(() => h.client.prepareRecoveryTransaction('forged-test', { ...capability })).toThrow();
  await h.client.executeOperation(operation.id);
  h.remote.txnStatus = 'executed';
  expect((await h.client.getOperation(operation.id))?.status).toBe('executed');
});
it('validates the separate factory + guest envelope when the intent wallet needs deployment', () => {
  const { prepared, intent, tx } = built();
  const salt = `0x${'12'.repeat(32)}` as const;
  const address = Address.from(hexToBytes(salt), recoveryContext);
  prepared.intentAddress = address;
  prepared.payload.intentAddress = address;
  prepared.typedData.domain.verifyingContract = address;
  intent.originIntentAddress = address;
  prepared.payloadHash = validateTypedData(prepared.typedData, 137).digest;
  const call = (to: `0x${string}`, data: `0x${string}`): Payload.Call => ({
    to,
    data,
    value: 0n,
    gasLimit: 0n,
    delegateCall: false,
    onlyFallback: false,
    behaviorOnError: 'revert',
  });
  const payload: Payload.Calls = {
    type: 'call',
    space: 0n,
    nonce: 0n,
    calls: [
      call(
        recoveryContext.factory,
        encodeFunctionData({
          abi: deployAbi,
          functionName: 'deploy',
          args: [recoveryContext.stage1, salt],
        }),
      ),
      call(address, executeData(prepared.payload.encoded)),
    ],
  };
  const deployment = {
    ...tx,
    to: recoveryContext.guest,
    requiresDeploy: true,
    intentAddress: address,
    payloadHash: prepared.payloadHash,
    data: bytesToHex(Payload.encode(payload)),
  };
  expect(validateRecoveryTransaction(deployment, prepared, intent, owner, balances).to).toBe(
    recoveryContext.guest,
  );
  payload.calls[0].to = owner;
  expect(() =>
    validateRecoveryTransaction(
      { ...deployment, data: bytesToHex(Payload.encode(payload)) },
      prepared,
      intent,
      owner,
      balances,
    ),
  ).toThrow();
});
it('rejects calldata suffixes, altered signed calls, changed targets, hashes, chain and value', () => {
  const { prepared, intent, tx } = built();
  const mutations = [
    { ...tx, data: `${tx.data}00` },
    { ...tx, to: owner },
    { ...tx, value: '1' },
    { ...tx, chainId: 8453 },
    { ...tx, payloadHash: `0x${'ff'.repeat(32)}` },
    { ...tx, data: executeData(`${prepared.payload.encoded}00`) },
    { ...tx, requiresDeploy: true },
    { ...tx, data: executeData(prepared.payload.encoded, '0x') },
  ];
  for (const variant of mutations)
    expect(() => validateRecoveryTransaction(variant, prepared, intent, owner, balances)).toThrow();
});
it('prepares only the managed wallet self-call for owner deployment, and rejects unsponsored recovery', async () => {
  const h = sdkHarness();
  await h.client.createOrRestore();
  await h.client.prepareDeployment('deployment-test', 8453);
  expect(h.remote.calls.find((c) => c.method === 'PrepareEthereumTransaction')?.body).toMatchObject(
    { network: '8453', to: owner, value: '0', data: '0x', mode: 'relayer' },
  );
  h.remote.sponsored = false;
  await expect(h.client.prepareDeployment('deployment-fail', 137)).rejects.toMatchObject({
    code: 'SPONSORSHIP_REQUIRED',
  });
  const { prepared, intent, tx } = built();
  await expect(
    h.client.prepareRecoveryTransaction(
      'recovery-fail',
      validateRecoveryTransaction(tx, prepared, intent, owner, balances),
    ),
  ).rejects.toMatchObject({ code: 'SPONSORSHIP_REQUIRED' });
});
