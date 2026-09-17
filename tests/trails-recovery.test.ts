import { describe, expect, it } from 'vitest';
import { validateRecoveryPayload } from '../packages/server-wallet-sdk/src/trails/recovery.js';
import { intentSchema } from '../packages/server-wallet-sdk/src/trails/protocol.js';
import { validateTypedData } from '../packages/server-wallet-sdk/src/typed-data.js';
import {
  contracts,
  owner,
  quoteFixture,
  recoveryCall,
  recoveryFixture,
  token,
  transferData,
  word,
} from './fixtures/trails.js';

const intent = intentSchema.parse(quoteFixture().intent);
const balances = [
  { asset: token, amount: '1000' },
  { asset: 'native', amount: '1000' },
];
const sweepData = (recipient = owner, tokens = [token], native = true) =>
  `0xa7b7ec5a${word(recipient)}${word(96n)}${word(native ? 1n : 0n)}${word(BigInt(tokens.length))}${tokens.map(word).join('')}`;

describe('Sequence recovery authorization', () => {
  it.each(['origin', 'destination'] as const)(
    'binds Go-encoded token refunds to the %s intent wallet and chain',
    (source) => {
      const prepared = recoveryFixture([recoveryCall()], source);
      expect(validateRecoveryPayload(prepared, intent, owner, balances)).toMatchObject({
        digest: prepared.payloadHash,
      });
    },
  );
  it('accepts canonical native and batched refunds, preserving integer precision', () => {
    const calls = [recoveryCall({ to: owner, value: '1000', data: '0x' }), recoveryCall()];
    const prepared = recoveryFixture(calls);
    expect(validateRecoveryPayload(prepared, intent, owner, balances).digest).toBe(
      prepared.payloadHash,
    );
    const large = '123456789012345678901234567890';
    const bigRefund = recoveryFixture([recoveryCall({ data: transferData(owner, large) })]);
    expect(
      validateRecoveryPayload(bigRefund, intent, owner, [{ asset: token, amount: large }]).digest,
    ).toBe(bigRefund.payloadHash);
  });
  it('also accepts the pinned TS representation of zero nonce and empty calldata', () => {
    const prepared = recoveryFixture([recoveryCall({ to: owner, value: '1000', data: '0x' })]);
    const goBytes = prepared.payload.encoded;
    // Single call + one nonce byte, followed by the call's explicit empty data.
    prepared.payload.encoded = `0x12${goBytes.slice(4, 44)}0046${goBytes.slice(46)}000000`;
    expect(validateRecoveryPayload(prepared, intent, owner, balances).digest).toBe(
      prepared.payloadHash,
    );
  });
  it('accepts only reviewed assets in a canonical TrailsUtils sweep', () => {
    const prepared = recoveryFixture([
      recoveryCall({ to: contracts.trailsUtilsAddress, data: sweepData() }),
    ]);
    expect(validateRecoveryPayload(prepared, intent, owner, balances).digest).toBe(
      prepared.payloadHash,
    );
    for (const data of [
      sweepData(token),
      sweepData(owner, [owner]),
      sweepData(owner, [token, token]),
      sweepData(owner, [], false),
      `${sweepData()}00`,
    ]) {
      expect(() =>
        validateRecoveryPayload(
          recoveryFixture([recoveryCall({ to: contracts.trailsUtilsAddress, data })]),
          intent,
          owner,
          balances,
        ),
      ).toThrow(/Recovery must/);
    }
    expect(() =>
      validateRecoveryPayload(prepared, intent, owner, [{ asset: token, amount: '1000' }]),
    ).toThrow();
  });
  it.each([
    { to: owner, data: transferData(owner, '1000') },
    { data: transferData(token, '1000') },
    { data: transferData(owner, '1001') },
    { data: transferData(owner, '0') },
    { value: '1' },
    { delegateCall: true },
    { onlyFallback: true },
    { behaviorOnError: '0' },
    { behaviorOnError: '2' },
    { gasLimit: '1' },
    { data: '0x095ea7b3' },
    { data: `${transferData(owner, '1000')}00` },
    { to: owner, value: '1001', data: '0x' },
  ])('rejects unsafe calls even when the supplied typed-data hash agrees', (change) => {
    const prepared = recoveryFixture([recoveryCall(change)]);
    expect(() => validateRecoveryPayload(prepared, intent, owner, balances)).toThrow(
      /Recovery must/,
    );
  });
  it('checks cumulative token/native amounts and prevents a repeated sweep', () => {
    for (const calls of [
      [recoveryCall(), recoveryCall()],
      [
        recoveryCall({ to: owner, value: '1000', data: '0x' }),
        recoveryCall({ to: owner, value: '1', data: '0x' }),
      ],
      [recoveryCall({ to: contracts.trailsUtilsAddress, data: sweepData() }), recoveryCall()],
    ])
      expect(() =>
        validateRecoveryPayload(recoveryFixture(calls), intent, owner, balances),
      ).toThrow();
  });
  it('rejects tampered envelopes, hashes, domains, parent wallets and trailing bytes', () => {
    const fixture = recoveryFixture();
    const variants = [
      { ...fixture, intentId: `0x${'00'.repeat(32)}` },
      { ...fixture, intentProtocol: 'v1' },
      { ...fixture, chainId: 1 },
      { ...fixture, intentAddress: owner },
      { ...fixture, payload: { ...fixture.payload, chainId: 1 } },
      { ...fixture, payload: { ...fixture.payload, intentAddress: owner } },
      { ...fixture, payload: { ...fixture.payload, encoding: 'json' } },
      { ...fixture, payload: { ...fixture.payload, encoded: `${fixture.payload.encoded}00` } },
      { ...fixture, payload: { ...fixture.payload, encoded: '0x' } },
      { ...fixture, payloadHash: `0x${'00'.repeat(32)}` },
    ];
    for (const prepared of variants)
      expect(() => validateRecoveryPayload(prepared, intent, owner, balances)).toThrow();
    for (const field of ['name', 'version', 'verifyingContract'] as const) {
      const prepared = structuredClone(fixture);
      prepared.typedData.domain[field] = field === 'verifyingContract' ? owner : 'wrong';
      prepared.payloadHash = validateTypedData(prepared.typedData, 137).digest;
      expect(() => validateRecoveryPayload(prepared, intent, owner, balances)).toThrow();
    }
    const parents = structuredClone(fixture);
    parents.typedData.message.wallets = [owner];
    parents.payloadHash = validateTypedData(parents.typedData, 137).digest;
    expect(() => validateRecoveryPayload(parents, intent, owner, balances)).toThrow();
    expect(() => validateRecoveryPayload(fixture, intent, token, balances)).toThrow();
    expect(() => validateRecoveryPayload(fixture, intent, owner, [])).toThrow();
  });
  it('rejects zero/reserved spaces, nonzero nonces, and empty recovery batches', () => {
    const fixture = recoveryFixture();
    for (const space of ['0', '1']) {
      const prepared = structuredClone(fixture);
      prepared.payload.encoded = `0x10${BigInt(space).toString(16).padStart(40, '0')}${fixture.payload.encoded.slice(44)}`;
      expect(() => validateRecoveryPayload(prepared, intent, owner, balances)).toThrow();
    }
    const nonzero = structuredClone(fixture);
    nonzero.payload.encoded = `0x12${fixture.payload.encoded.slice(4, 44)}01${fixture.payload.encoded.slice(44)}`;
    expect(() => validateRecoveryPayload(nonzero, intent, owner, balances)).toThrow();
    expect(() => validateRecoveryPayload(recoveryFixture([]), intent, owner, balances)).toThrow();
  });
});
