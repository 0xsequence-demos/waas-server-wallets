import { EncryptedStore } from '@polygonlabs/oms-server-wallet-sdk';
import {
  swapView,
  type SwapRecord,
  type SwapStore,
} from '@polygonlabs/oms-server-wallet-sdk/trails';
import type { Repository, SqlDatabase } from './database.js';

export const authoritySchema = `CREATE TABLE IF NOT EXISTS swap_authority (
  namespace TEXT NOT NULL, id TEXT NOT NULL, intent_id TEXT NOT NULL, wallet_id TEXT NOT NULL, subject TEXT NOT NULL,
  version INTEGER NOT NULL, phase TEXT NOT NULL, created_at TEXT NOT NULL,
  next_at INTEGER, active INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 1, value TEXT NOT NULL,
  PRIMARY KEY(namespace, id), UNIQUE(namespace, intent_id))`;
/** Atomic encrypted journal + projection outbox. A wake-up is durable before the record is committed. */
export class SqlSwapStore implements SwapStore {
  constructor(
    readonly db: SqlDatabase,
    readonly namespace: string,
    readonly walletId: string,
    readonly subject: string,
    private readonly key: string,
    private readonly wake: (at: number) => Promise<void> = async () => {},
    private readonly report?: (event: Record<string, string | number | null | undefined>) => void,
  ) {}
  private encrypted(onWrite?: (value: string) => Promise<void>) {
    return new EncryptedStore(
      {
        read: async (id) =>
          (
            await this.db.all<{ value: string }>(
              'SELECT value FROM swap_authority WHERE namespace = ? AND id = ?',
              [this.namespace, id],
            )
          )[0]?.value ?? null,
        write: async (_id, value) => {
          if (!onWrite) throw new Error('Read-only store');
          await onWrite(value);
        },
      },
      this.key,
      `${this.namespace}:swaps`,
    );
  }
  async get(id: string): Promise<SwapRecord | null> {
    const value = await this.encrypted().read(id);
    return value === null ? null : (JSON.parse(value) as SwapRecord);
  }
  async findIntent(intentId: string) {
    return (
      (
        await this.db.all<{ id: string }>(
          'SELECT id FROM swap_authority WHERE namespace = ? AND intent_id = ?',
          [this.namespace, intentId],
        )
      )[0]?.id ?? null
    );
  }
  async save(record: SwapRecord) {
    const snapshot = structuredClone(record);
    await this.encrypted(async (value) => {
      await this.wake(Math.min(snapshot.nextAt ?? Infinity, Date.now() + 30_000));
      await this.db.run(
        `INSERT INTO swap_authority(namespace,id,intent_id,wallet_id,subject,version,phase,created_at,next_at,active,dirty,value)
        VALUES(?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(namespace,id) DO UPDATE SET version=excluded.version,phase=excluded.phase,next_at=excluded.next_at,active=excluded.active,dirty=1,value=excluded.value
        WHERE excluded.version > swap_authority.version`,
        [
          this.namespace,
          snapshot.id,
          snapshot.quote.intent.intentId,
          this.walletId,
          this.subject,
          snapshot.version,
          snapshot.phase,
          snapshot.createdAt,
          snapshot.nextAt,
          snapshot.action ? 1 : 0,
          value,
        ],
      );
    }).write(snapshot.id, JSON.stringify(snapshot));
    try {
      this.report?.({
        event: 'swap_state',
        walletId: this.walletId,
        swapId: snapshot.id,
        intentId: snapshot.quote.intent.intentId,
        phase: snapshot.phase,
        action: snapshot.action,
        chainId: snapshot.request.originChainId,
        version: snapshot.version,
        error: snapshot.error,
        fundingStatus: snapshot.funding?.status,
        recoveryId: snapshot.activeRecoveryId,
        repairAttemptedAt: snapshot.repairAttemptedAt,
      });
    } catch {
      /* Logging must not affect a durable authorization. */
    }
  }
  async list(options: { active?: boolean; offset?: number; limit: number }) {
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM swap_authority WHERE namespace = ? ${options.active ? 'AND active = 1' : ''} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
      [this.namespace, options.limit, options.offset ?? 0],
    );
    return (await Promise.all(rows.map((r) => this.get(r.id)))).filter(
      (r): r is SwapRecord => r !== null,
    );
  }
  async nextDue(): Promise<number | null> {
    const [row] = await this.db.all<{ next_at: number | null; dirty: number | null }>(
      'SELECT MIN(next_at) AS next_at, MAX(dirty) AS dirty FROM swap_authority WHERE namespace = ?',
      [this.namespace],
    );
    if (!row) return null;
    const next = Math.min(row.next_at ?? Infinity, row.dirty ? Date.now() + 30_000 : Infinity);
    return Number.isFinite(next) ? next : null;
  }
  async flush(repo: Repository): Promise<boolean> {
    const rows = await this.db.all<{ id: string }>(
      'SELECT id FROM swap_authority WHERE namespace = ? AND dirty = 1 LIMIT 50',
      [this.namespace],
    );
    try {
      for (const row of rows) {
        const record = await this.get(row.id);
        if (!record) continue;
        await repo.projectSwap(this.walletId, swapView(record));
        await this.db.run(
          'UPDATE swap_authority SET dirty = 0 WHERE namespace = ? AND id = ? AND version = ?',
          [this.namespace, row.id, record.version],
        );
      }
      return true;
    } catch {
      return false;
    } // Leave outbox dirty. Never repeat a wallet action to repair this projection.
  }
}
