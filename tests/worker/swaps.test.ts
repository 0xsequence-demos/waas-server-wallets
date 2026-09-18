import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { EncryptedStore } from '@polygonlabs/oms-server-wallet-sdk';
import { validateSwapQuote, type SwapRecord } from '@polygonlabs/oms-server-wallet-sdk/trails';
import type { WalletCoordinator } from '../../apps/server/worker.js';
import { configFrom, scopeFor } from '../../apps/server/config.js';
import { quoteFixture, contracts, owner } from '../fixtures/trails.js';

async function seed(stub: DurableObjectStub<WalletCoordinator>, count = 1) {
  const config = configFrom(env),
    scope = scopeFor(config);
  await stub.execute('swap-worker-test', { kind: 'inspect' });
  const f = quoteFixture();
  f.intent.expiresAt = new Date(Date.now() + 900_000).toISOString();
  const quote = await validateSwapQuote(f.intent, f.request, contracts, Date.now());
  await runInDurableObject(stub, async (_instance, state) => {
    // Model an existing pre-swap encrypted wallet state: no new identity or credentials required.
    const store = new EncryptedStore(
      {
        read: async (key) =>
          state.storage.sql
            .exec<{ value: string }>('SELECT value FROM state WHERE key=?', key)
            .toArray()[0]?.value ?? null,
        write: async (key, value) => {
          state.storage.sql.exec(
            'INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            key,
            value,
          );
        },
      },
      config.ENCRYPTION_KEY,
      `${scope}:swap-worker-test`,
    );
    await store.write(
      'wallet',
      JSON.stringify({
        wallet: { id: 'remote', address: owner, networkFamily: 'evm' },
        disabled: true,
        creationUncertain: false,
      }),
    );
    const encrypted = new EncryptedStore(
      {
        read: async () => null,
        write: async (id, value) => {
          state.storage.sql.exec(
            'INSERT INTO swap_authority(namespace,id,intent_id,wallet_id,subject,version,phase,created_at,next_at,active,dirty,value) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            `${scope}:swap-worker-test`,
            id,
            `${id}-intent`,
            'swap-worker-test',
            'swap-worker-test',
            1,
            'preparing',
            new Date().toISOString(),
            Date.now() - 1000,
            1,
            1,
            value,
          );
        },
      },
      config.ENCRYPTION_KEY,
      `${scope}:swap-worker-test:swaps`,
    );
    for (let i = 0; i < count; i++) {
      const record: SwapRecord = {
        id: `worker-swap-${i}`,
        version: 1,
        requestHash: 'fixture',
        environment: JSON.stringify([config.TRAILS_API_URL, config.TRAILS_PROJECT_ID]),
        request: f.input,
        owner,
        quote,
        phase: 'preparing',
        action: 'prepare-funding',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
        nextAt: Date.now() - 1000,
        attempts: 0,
        fundingId: `swp_worker_${i}`,
        fundingConfirmed: false,
        recoveries: [],
      };
      await encrypted.write(record.id, JSON.stringify(record));
    }
    await state.storage.setAlarm(Date.now() + 60_000);
  });
}
it('resumes multiple persisted swaps after DO eviction, redelivery and prolonged projection outages', async () => {
  const stub = env.WALLETS.getByName(crypto.randomUUID());
  await seed(stub, 5);
  await evictDurableObject(stub);
  // No catalog projection table exists in this test. That failure must not consume the alarm.
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ version: number }>('SELECT version FROM swap_authority')
      .toArray();
    expect(rows.filter((r) => r.version > 1)).toHaveLength(3);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  for (let i = 0; i < 8; i++) {
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  }
  await evictDurableObject(stub);
  const result = await stub.execute('swap-worker-test', { kind: 'swap-get', id: 'worker-swap-0' });
  expect(result).toMatchObject({
    ok: true,
    value: { swap: { phase: 'preparing', error: 'SWAPS_DISABLED' } },
  });
});
it('retains pre-existing credential storage and rejects identity rebinding on the same coordinator', async () => {
  const stub = env.WALLETS.getByName(crypto.randomUUID());
  await stub.execute('existing-subject', { kind: 'disable' });
  expect(await stub.execute('different-subject', { kind: 'inspect' })).toMatchObject({
    ok: false,
    code: 'WALLET_MISMATCH',
  });
  await evictDurableObject(stub);
  expect(await stub.execute('existing-subject', { kind: 'inspect' })).toMatchObject({
    ok: true,
    value: { snapshot: { disabled: true } },
  });
});
it('explicitly rearms an alarm when encrypted state cannot be read', async () => {
  const stub = env.WALLETS.getByName(crypto.randomUUID());
  await seed(stub);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE swap_authority SET value='corrupt'");
  });
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});
