import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Repository, type SqlDatabase } from '../apps/server/database.js';
import { SqlSwapStore } from '../apps/server/swaps-store.js';
import { NodeSwapRunner } from '../apps/server/node-runner.js';
import { migrate } from '../apps/server/migrate.js';
import { testDatabase } from './helpers.js';
import { swapHarness } from './swap-harness.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
async function setup() {
  const { db, sqlite } = testDatabase();
  databases.push(sqlite);
  const repo = new Repository(db, 'scope');
  const wallet = await repo.reserve('customer-1', 'Treasury');
  const wake = vi.fn(async (_at: number) => {});
  const store = new SqlSwapStore(
    db,
    'scope:customer-1',
    wallet.id,
    wallet.identifier,
    btoa('k'.repeat(32)),
    wake,
  );
  const h = await swapHarness();
  await h.confirm();
  const record = await h.record();
  return { db, sqlite, repo, wallet, wake, store, record };
}
it('upgrades an existing Node database transactionally without losing wallets or credential state', () => {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(
    "INSERT INTO wallets VALUES('wallet','scope','sub','Name','encrypted-snapshot','2026-01-01'); PRAGMA user_version=1;",
  );
  migrate(sqlite);
  migrate(sqlite);
  expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
  expect(sqlite.prepare('SELECT snapshot FROM wallets').get()?.snapshot).toBe('encrypted-snapshot');
  expect(sqlite.prepare('SELECT * FROM swap_authority').all()).toEqual([]);
});
it('arms wake-up before atomically storing encrypted work and rejects tampering/cross-wallet reads', async () => {
  const s = await setup();
  s.wake.mockImplementation(async () => {
    expect((await s.db.all('SELECT * FROM swap_authority')).length).toBe(0);
  });
  await s.store.save(s.record);
  expect(s.wake).toHaveBeenCalled();
  const [raw] = await s.db.all<{ value: string }>('SELECT value FROM swap_authority');
  expect(raw.value).not.toContain('funding');
  expect(raw.value).not.toContain(s.record.owner);
  const restarted = new SqlSwapStore(
    s.db,
    'scope:customer-1',
    s.wallet.id,
    s.wallet.identifier,
    btoa('k'.repeat(32)),
  );
  expect(await restarted.get(s.record.id)).toEqual(s.record);
  const other = new SqlSwapStore(s.db, 'scope:other', s.wallet.id, 'other', btoa('k'.repeat(32)));
  expect(await other.get(s.record.id)).toBeNull();
  await s.db.run('UPDATE swap_authority SET value=?', [
    JSON.stringify({ v: 1, iv: 'AA', data: 'AA' }),
  ]);
  await expect(s.store.get(s.record.id)).rejects.toMatchObject({ code: 'STORAGE_INTEGRITY' });
});
it('retries failed projections without rolling back the journal or overwriting newer summaries', async () => {
  const s = await setup();
  await s.store.save(s.record);
  const project = vi.spyOn(s.repo, 'projectSwap').mockRejectedValueOnce(new Error('D1 outage'));
  expect(await s.store.flush(s.repo)).toBe(false);
  expect(await s.store.nextDue()).not.toBeNull();
  expect((await s.store.get(s.record.id))?.action).toBe('prepare-funding');
  expect(await s.store.flush(s.repo)).toBe(true);
  expect(project).toHaveBeenCalledTimes(2);
  const [row] = await s.db.all<{ summary: string }>('SELECT summary FROM swap_summaries');
  expect(row.summary).not.toContain('payload');
  const summary = JSON.parse(row.summary);
  await s.repo.projectSwap(s.wallet.id, { ...summary, version: 0, phase: 'failed' });
  expect((await s.db.all<{ phase: string }>('SELECT phase FROM swap_summaries'))[0].phase).toBe(
    'preparing',
  );
  s.record.version++;
  s.record.action = null;
  s.record.nextAt = null;
  s.record.phase = 'succeeded';
  await s.store.save(s.record);
  await s.store.flush(s.repo);
  expect(await s.store.nextDue()).toBeNull();
});
it('never clears a newer outbox revision when an old projection completes', async () => {
  const s = await setup();
  await s.store.save(s.record);
  const project = s.repo.projectSwap.bind(s.repo);
  vi.spyOn(s.repo, 'projectSwap').mockImplementation(async (id, view) => {
    s.record.version++;
    await s.store.save(s.record);
    await project(id, view);
  });
  await s.store.flush(s.repo);
  expect((await s.db.all<{ dirty: number }>('SELECT dirty FROM swap_authority'))[0].dirty).toBe(1);
});
it('does not commit authorization when durable scheduling fails', async () => {
  const s = await setup();
  s.wake.mockRejectedValue(new Error('alarm failed'));
  await expect(s.store.save(s.record)).rejects.toThrow('alarm failed');
  expect(await s.store.get(s.record.id)).toBeNull();
});
it('Node runner discovers persisted work after restart and excludes other environments', async () => {
  const s = await setup();
  await s.store.save(s.record);
  const otherRepo = new Repository(s.db, 'other');
  const foreign = await otherRepo.reserve('customer-2', 'Other');
  const otherStore = new SqlSwapStore(
    s.db,
    'other:customer-2',
    foreign.id,
    foreign.identifier,
    btoa('k'.repeat(32)),
  );
  await otherStore.save({ ...s.record, id: 'other-swap-001' });
  let resolve: () => void = () => {};
  const barrier = new Promise<void>((r) => {
    resolve = r;
  });
  const dispatch = vi.fn(async () => {
    await barrier;
    return {
      ok: true as const,
      value: { snapshot: { disabled: false, creationUncertain: false } },
    };
  });
  const runner = new NodeSwapRunner(s.repo, dispatch);
  const first = runner.tick();
  const second = runner.tick();
  expect(first).toBe(second);
  await new Promise((r) => setTimeout(r, 1));
  expect(dispatch).toHaveBeenCalledTimes(1);
  resolve();
  await first;
  await runner.stop();
  await runner.tick();
  expect(dispatch).toHaveBeenCalledTimes(1);
  const restarted = new NodeSwapRunner(s.repo, dispatch);
  await restarted.tick();
  expect(dispatch).toHaveBeenCalledTimes(2);
  await restarted.stop();
});
it('bounds quote requests independently and resets the window', async () => {
  const s = await setup();
  for (let i = 0; i < 12; i++) expect(await s.repo.quoteAllowed(s.wallet.id, 1000)).toBe(true);
  expect(await s.repo.quoteAllowed(s.wallet.id, 1000)).toBe(false);
  expect(await s.repo.quoteAllowed(s.wallet.id, 61000)).toBe(true);
});
it('keeps dirty work scheduled when the catalog schema is temporarily unavailable', async () => {
  const s = await setup();
  await s.store.save(s.record);
  const broken: SqlDatabase = {
    ...s.db,
    run: async () => {
      throw new Error('missing table');
    },
  };
  expect(await s.store.flush(new Repository(broken, 'scope'))).toBe(false);
  expect(await s.store.nextDue()).not.toBeNull();
});
