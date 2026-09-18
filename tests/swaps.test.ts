import { describe, expect, it } from 'vitest';
import { swapView } from '@polygonlabs/oms-server-wallet-sdk/trails';
import { swapHarness } from './swap-harness.js';
import {
  owner,
  token,
  destinationToken,
  recoveryFixture,
  recoveryCall,
} from './fixtures/trails.js';

const executes = (h: Awaited<ReturnType<typeof swapHarness>>) =>
  h.waas.remote.calls.filter((c) => c.method === 'Execute');
async function funded(h: Awaited<ReturnType<typeof swapHarness>>) {
  await h.confirm();
  await h.tick(4);
  h.waas.remote.txnStatus = 'executed';
  await h.tick();
  expect((await h.record()).fundingConfirmed).toBe(true);
}
describe('durable swap execution', () => {
  it.each([false, true])(
    'activates before exactly one sponsored deposit (native=%s), then verifies settlement',
    async (native) => {
      const h = await swapHarness(native);
      await h.confirm();
      await h.tick();
      expect(executes(h)).toHaveLength(0);
      await h.tick();
      expect(h.calls.filter((c) => c === 'activate')).toHaveLength(1);
      expect(executes(h)).toHaveLength(0);
      await h.tick(2);
      expect(executes(h)).toHaveLength(1);
      h.restart();
      await h.tick();
      expect(executes(h)).toHaveLength(1);
      h.waas.remote.txnStatus = 'executed';
      await h.tick();
      expect((await h.record()).phase).toBe('settling');
      h.receipt.status = 'SUCCEEDED';
      h.receipt.summary.destinationToAddress = owner;
      h.receipt.summary.destinationTokenAddress = destinationToken;
      h.receipt.summary.destinationTokenAmount = '9900000';
      await h.tick();
      expect((await h.record()).phase).toBe('succeeded');
      expect(executes(h)).toHaveLength(1);
      expect(h.calls).not.toContain('commit');
    },
  );
  it('keeps retry IDs stable and rejects changed confirmation/input', async () => {
    const h = await swapHarness();
    const quote = await h.quote();
    expect(await h.quote()).toEqual(quote);
    expect(h.calls.filter((c) => c === 'quote')).toHaveLength(1);
    await expect(
      h.swaps.quoteSwap(quote.id, { ...h.fixture.input, amount: '99' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(h.swaps.confirmSwap(quote.id, 'stale')).rejects.toMatchObject({
      code: 'STALE_QUOTE',
    });
    await Promise.all([
      h.swaps.confirmSwap(quote.id, quote.quote.revision),
      h.swaps.confirmSwap(quote.id, quote.quote.revision),
    ]);
    await h.tick(4);
    expect(executes(h)).toHaveLength(1);
  });
  it('reconciles a lost activation response before funding', async () => {
    const h = await swapHarness();
    h.flags.loseActivation = true;
    await h.confirm();
    await h.tick(2);
    h.restart();
    h.advance(20_000);
    await h.tick(2);
    expect(h.calls.filter((c) => c === 'activate')).toHaveLength(1);
    expect(executes(h)).toHaveLength(1);
  });
  it('never expires a stale parent snapshot after a submission crash', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(3);
    h.store.fail = (r) => r.funding?.status === 'pending' || r.funding?.status === 'unknown';
    await expect(h.tick()).rejects.toThrow();
    expect(executes(h)).toHaveLength(1);
    h.store.fail = undefined;
    h.advance(1_000_000);
    h.restart();
    await h.tick();
    expect((await h.record()).action).toBe('fund');
    expect(executes(h)).toHaveLength(1);
    h.waas.remote.txnStatus = 'executed';
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
  });
  it('retains an unknown debit through expiry, disable/re-enable, and restarts', async () => {
    const h = await swapHarness();
    await h.confirm();
    h.waas.remote.failExecute = true;
    await h.tick(4);
    h.waas.remote.txnStatus = 'quoted';
    h.advance(1_000_000);
    h.restart();
    await h.tick();
    expect((await h.record()).funding?.status).toBe('unknown');
    await h.waas.client.setDisabled(true);
    const auth = h.waas.remote.calls.length;
    await h.tick();
    expect(h.waas.remote.calls.length).toBe(auth);
    await h.waas.client.setDisabled(false);
    h.waas.remote.txnStatus = 'executed';
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(true);
    expect(executes(h)).toHaveLength(1);
  });
  it('blocks concurrent ordinary debits and imports legacy unresolved operation IDs', async () => {
    const h = await swapHarness();
    await h.confirm();
    await expect(
      h.swaps.prepareTransfer('normal-transfer', {
        chainId: 137,
        to: owner,
        asset: 'native',
        amount: '1',
      }),
    ).rejects.toMatchObject({ code: 'DEBIT_PENDING' });
    await h.tick(4);
    await expect(h.swaps.executeTransfer('swp_fund_fake')).rejects.toThrow();
  });
  it('checks fresh funds, sponsorship and approvals before any funding', async () => {
    const h = await swapHarness();
    const q = await h.quote();
    h.flags.balance = '0';
    await expect(h.swaps.confirmSwap(q.id, q.quote.revision)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    h.flags.balance = '10000000';
    await h.confirm();
    h.waas.remote.sponsored = false;
    await h.tick();
    expect((await h.record()).phase).toBe('failed');
    expect(executes(h)).toHaveLength(0);
    expect(h.calls).not.toContain('activate');
  });
  it('does not fund an expired quote or a mismatched/not-yet-visible deposit leg', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(2);
    h.flags.missingReceipt = true;
    await h.tick();
    expect(executes(h)).toHaveLength(0);
    h.flags.missingReceipt = false;
    h.receipt.depositTransaction!.toAddress = owner;
    await h.tick();
    expect(executes(h)).toHaveLength(0);
    h.advance(1_000_000);
    await h.tick();
    expect((await h.record()).phase).toBe('expired');
  });
  it('requires a successful chain receipt and the managed destination/minimum output', async () => {
    const h = await swapHarness();
    await funded(h);
    h.receipt.status = 'SUCCEEDED';
    h.receipt.summary.destinationToAddress = owner;
    h.receipt.summary.destinationTokenAddress = destinationToken;
    h.receipt.summary.destinationTokenAmount = '1';
    await h.tick();
    expect((await h.record()).phase).toBe('attention');
  });
  it('repairs only a confirmed delayed deposit and does not send another transfer', async () => {
    const h = await swapHarness();
    await funded(h);
    h.intent.status = 'INVALID';
    h.receipt.status = 'INVALID';
    h.receipt.depositTransaction!.status = 'FAILED';
    await h.tick();
    expect(h.calls.filter((c) => c === 'repair')).toHaveLength(1);
    expect(executes(h)).toHaveLength(1);
    await h.tick(8);
    expect(h.calls.filter((c) => c === 'repair')).toHaveLength(1);
  });
  it('keeps polling automatic refunds and binds work to the original environment', async () => {
    const h = await swapHarness();
    await funded(h);
    h.restart(true, 'changed-project');
    await h.tick();
    expect((await h.record()).error).toBe('SWAP_ENVIRONMENT_CHANGED');
    h.restart();
    h.advance(20_000);
    h.receipt.status = 'REFUNDED';
    h.receipt.refundTransaction = {
      ...h.receipt.depositTransaction!,
      type: 'REFUND',
      status: 'SUCCEEDED',
      toAddress: owner,
    };
    await h.tick();
    expect((await h.record()).phase).toBe('refunded');
  });
  it('pauses new funding but continues funded observation with the feature disabled', async () => {
    const h = await swapHarness();
    await funded(h);
    h.restart(false);
    h.receipt.status = 'REFUNDED';
    h.receipt.refundTransaction = {
      ...h.receipt.depositTransaction!,
      type: 'REFUND',
      status: 'SUCCEEDED',
      toAddress: owner,
    };
    await h.tick();
    expect((await h.record()).phase).toBe('refunded');
    await expect(h.swaps.quoteSwap('new-swap-0002', h.fixture.input)).rejects.toMatchObject({
      code: 'SWAPS_DISABLED',
    });
  });
  it('backs off across provider outages without treating a hash as success', async () => {
    const h = await swapHarness();
    await h.confirm();
    await h.tick(4);
    h.waas.remote.txnStatus = 'executed';
    h.flags.chainFailure = true;
    await h.tick();
    expect((await h.record()).fundingConfirmed).toBe(false);
    expect((await h.record()).attempts).toBe(1);
    h.restart();
    h.advance(20_000);
    h.flags.chainFailure = false;
    await h.tick();
    expect((await h.record()).phase).toBe('settling');
  });
});
describe('reviewed recovery', () => {
  async function ready() {
    const h = await swapHarness();
    await funded(h);
    h.intent.status = 'FAILED';
    h.receipt.status = 'FAILED';
    h.flags.intentBalance = '1000';
    return h;
  }
  it('requires a separate review, signs only validated payloads and verifies returned balances', async () => {
    const h = await ready();
    const view = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-0001', 'origin');
    expect(view.recoveries[0].assets).toEqual([
      { asset: token, amount: '1000', symbol: token, decimals: 6 },
    ]);
    expect(h.calls).not.toContain('buildRecovery');
    await h.swaps.confirmRecovery(view.id, 'recovery-0001', view.recoveries[0].revision);
    await h.tick(3);
    expect(executes(h)).toHaveLength(2);
    h.restart();
    h.waas.remote.txnStatus = 'executed';
    h.flags.intentBalance = '0';
    h.flags.recovered = true;
    await h.tick();
    expect((await h.record()).recoveries[0].status).toBe('recovered');
    expect((await h.record()).phase).toBe('refunded');
    const publicView = JSON.stringify(swapView(await h.record()));
    expect(publicView).not.toContain('signature');
    expect(publicView).not.toContain('typedData');
    expect(publicView).not.toContain('payloadHash');
  });
  it('discloses owner deployment, waits for code and prevents duplicate deployment after restart', async () => {
    const h = await ready();
    h.flags.deployed = false;
    const v = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-0001', 'origin');
    expect(v.recoveries[0].requiresOwnerDeployment).toBe(true);
    await h.swaps.confirmRecovery(v.id, 'recovery-0001', v.recoveries[0].revision);
    await h.tick();
    expect(executes(h)).toHaveLength(2);
    h.restart();
    await h.tick();
    expect(executes(h)).toHaveLength(2);
    expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(0);
    h.flags.deployed = true;
    h.waas.remote.txnStatus = 'executed';
    await h.tick(2);
    expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(1);
  });
  it('rejects a changed recipient, side, balance, expiry or transaction target', async () => {
    const h = await ready();
    h.recovery = recoveryFixture([recoveryCall({ to: owner })]) as typeof h.recovery;
    await expect(
      h.swaps.prepareRecovery('swap-test-0001', 'recovery-bad1', 'origin'),
    ).rejects.toMatchObject({ code: 'INVALID_RECOVERY' });
    h.recovery = recoveryFixture() as typeof h.recovery;
    const v = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-0001', 'origin');
    h.flags.intentBalance = '999';
    await expect(
      h.swaps.confirmRecovery(v.id, 'recovery-0001', v.recoveries[0].revision),
    ).rejects.toMatchObject({ code: 'RECOVERY_CHANGED' });
    h.flags.intentBalance = '1000';
    await h.swaps.confirmRecovery(v.id, 'recovery-0001', v.recoveries[0].revision);
    h.flags.badBuild = true;
    await h.tick(2);
    expect((await h.record()).recoveries[0].status).toBe('failed');
    expect(executes(h)).toHaveLength(1);
  });

  it.each([false, true])(
    'releases a reverted recovery debit for a fresh review without resubmission (deployment=%s)',
    async (deployment) => {
      const h = await ready();
      h.flags.deployed = !deployment;
      const view = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-revert', 'origin');
      await h.swaps.confirmRecovery(view.id, 'recovery-revert', view.recoveries[0].revision);
      await h.tick(deployment ? 1 : 3);
      expect(executes(h)).toHaveLength(2);
      h.flags.chainReverted = true;
      h.waas.remote.txnStatus = 'executed';
      h.restart();
      await h.tick();
      const record = await h.record();
      expect(record.recoveries[0].status).toBe('failed');
      expect(record.activeRecoveryId).toBeUndefined();
      expect(record.phase).toBe('attention');
      expect(executes(h)).toHaveLength(2);
      expect(
        (await h.swaps.prepareRecovery(view.id, 'recovery-fresh', 'origin')).recoveries,
      ).toHaveLength(2);
    },
  );
  it('blocks recovery during normal progress, uncertain funding or another active recovery', async () => {
    const h = await swapHarness();
    await funded(h);
    await expect(
      h.swaps.prepareRecovery('swap-test-0001', 'recovery-0001', 'origin'),
    ).rejects.toMatchObject({ code: 'RECOVERY_NOT_READY' });
    h.intent.status = 'FAILED';
    h.flags.intentBalance = '1000';
    const v = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-0001', 'origin');
    await h.swaps.confirmRecovery(v.id, 'recovery-0001', v.recoveries[0].revision);
    await expect(h.swaps.prepareRecovery(v.id, 'recovery-0002', 'origin')).rejects.toMatchObject({
      code: 'RECOVERY_PENDING',
    });
  });
  it('allows recovery when new swaps are paused, but never signs for disabled wallets', async () => {
    const h = await ready();
    h.restart(false);
    const v = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-0001', 'origin');
    await h.swaps.confirmRecovery(v.id, 'recovery-0001', v.recoveries[0].revision);
    await h.waas.client.setDisabled(true);
    await h.tick();
    expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(0);
  });
});

it('keeps actual partial recovery amounts and permits a fresh review for residual funds', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  const view = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-partial', 'origin');
  await h.swaps.confirmRecovery(view.id, 'recovery-partial', view.recoveries[0].revision);
  await h.tick(3);
  h.waas.remote.txnStatus = 'executed';
  h.flags.recovered = true;
  h.flags.recoveredAmount = '900';
  h.flags.intentBalance = '0';
  await h.tick();
  const result = await h.swaps.getSwap(view.id);
  expect(result.recoveries[0]).toMatchObject({
    status: 'partial',
    received: [{ asset: token, amount: '900' }],
  });
  expect(result.phase).toBe('attention');
  expect(result.canRecover).toBe(true);
});

it('recovers a destination-side intermediate token without assuming the quoted output token', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  h.recovery = {
    ...recoveryFixture([recoveryCall()], 'destination'),
    recoveryTokens: [
      {
        contractAddress: token,
        balance: '1000',
        chainId: 8453,
        decimals: 6,
        symbol: 'INTERMEDIATE',
      },
    ],
  } as typeof h.recovery;
  const view = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-dest-1', 'destination');
  expect(view.recoveries[0]).toMatchObject({
    chainId: 8453,
    assets: [{ asset: token, symbol: 'INTERMEDIATE' }],
  });
  await h.swaps.confirmRecovery(view.id, 'recovery-dest-1', view.recoveries[0].revision);
  await h.tick(3);
  h.waas.remote.txnStatus = 'executed';
  h.flags.recovered = true;
  h.flags.intentBalance = '0';
  await h.tick();
  expect((await h.record()).recoveries[0].status).toBe('recovered');
});

it('retains an uncertain recovery through expiry and a crash before the parent commit', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  const view = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-crash', 'origin');
  await h.swaps.confirmRecovery(view.id, 'recovery-crash', view.recoveries[0].revision);
  await h.tick(2);
  h.store.fail = (r) => r.recoveries[0].transaction?.status === 'pending';
  await expect(h.tick()).rejects.toThrow();
  expect(executes(h)).toHaveLength(2);
  h.store.fail = undefined;
  h.advance(400_000);
  h.restart();
  await h.waas.client.setDisabled(true);
  await h.tick();
  expect((await h.record()).activeRecoveryId).toBe('recovery-crash');
  await h.waas.client.setDisabled(false);
  h.waas.remote.txnStatus = 'executed';
  h.flags.recovered = true;
  h.flags.intentBalance = '0';
  await h.tick();
  expect(executes(h)).toHaveLength(2);
  expect((await h.record()).recoveries[0].status).toBe('recovered');
});

it('never funds the same upstream intent under a second local swap ID', async () => {
  const h = await swapHarness();
  await h.quote();
  await expect(h.swaps.quoteSwap('second-local-id', h.fixture.input)).rejects.toMatchObject({
    code: 'INTENT_ALREADY_TRACKED',
  });
});

it('imports a legacy pending debit even when it is absent from the SDK operation index', async () => {
  const h = await swapHarness();
  await h.waas.client.prepareTransfer('legacy-debit-001', {
    chainId: 137,
    to: owner,
    asset: 'native',
    amount: '1',
  });
  await h.waas.client.executeTransfer('legacy-debit-001');
  h.waas.store.values.delete('operationIndex');
  h.legacyIds.push('legacy-debit-001');
  const quote = await h.quote();
  await expect(h.swaps.confirmSwap(quote.id, quote.quote.revision)).rejects.toMatchObject({
    code: 'DEBIT_PENDING',
  });
  h.waas.remote.txnStatus = 'executed';
  await h.swaps.confirmSwap(quote.id, quote.quote.revision);
  expect((await h.record()).phase).toBe('preparing');
});
it('blocks an already prepared ordinary transfer when a swap subsequently reserves its chain', async () => {
  const h = await swapHarness();
  await h.swaps.prepareTransfer('prepared-normal-1', {
    chainId: 137,
    to: owner,
    asset: 'native',
    amount: '1',
  });
  await h.confirm();
  await expect(h.swaps.executeTransfer('prepared-normal-1')).rejects.toMatchObject({
    code: 'DEBIT_PENDING',
  });
  expect(executes(h)).toHaveLength(0);
});
it('uses fresh recovery state and expires reviews before deploying or signing', async () => {
  const h = await swapHarness();
  await funded(h);
  h.intent.status = 'FAILED';
  h.receipt.status = 'FAILED';
  h.flags.intentBalance = '1000';
  h.flags.deployed = false;
  const view = await h.swaps.prepareRecovery('swap-test-0001', 'recovery-expiry', 'origin');
  await h.swaps.confirmRecovery(view.id, 'recovery-expiry', view.recoveries[0].revision);
  h.advance(310_000);
  await h.tick();
  expect((await h.record()).recoveries[0].status).toBe('failed');
  expect(executes(h)).toHaveLength(1);
  expect(h.waas.remote.calls.filter((c) => c.method === 'SignTypedData')).toHaveLength(0);
});
