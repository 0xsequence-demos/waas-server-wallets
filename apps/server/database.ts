import type { WalletSnapshot, Operation, StateStore } from '@polygonlabs/oms-server-wallet-sdk';
import type { SwapView } from '@polygonlabs/oms-server-wallet-sdk/trails';

export interface SqlDatabase {
  all<T extends Record<string, unknown>>(
    sql: string,
    params?: (string | number | null)[],
  ): Promise<T[]>;
  run(sql: string, params?: (string | number | null)[]): Promise<void>;
}
export interface WalletRow extends Record<string, unknown> {
  id: string;
  scope: string;
  identifier: string;
  name: string;
  snapshot: string | null;
  created_at: string;
}
export interface OperationRow extends Record<string, unknown> {
  id: string;
  wallet_id: string;
  kind: string;
  result: string | null;
  created_at: string;
}
export class Repository {
  constructor(
    readonly db: SqlDatabase,
    readonly scope: string,
  ) {}
  async list(search = '', offset = 0) {
    return this.db.all<WalletRow>(
      "SELECT * FROM wallets WHERE scope = ? AND (instr(lower(identifier), lower(?)) > 0 OR instr(lower(name), lower(?)) > 0 OR instr(lower(coalesce(json_extract(snapshot, '$.wallet.address'), '')), lower(?)) > 0) ORDER BY created_at DESC, id LIMIT 50 OFFSET ?",
      [this.scope, search, search, search, offset],
    );
  }
  async get(id: string) {
    return (
      (
        await this.db.all<WalletRow>('SELECT * FROM wallets WHERE id = ? AND scope = ?', [
          id,
          this.scope,
        ])
      )[0] ?? null
    );
  }
  async reserve(identifier: string, name: string) {
    await this.db.run(
      'INSERT INTO wallets(id, scope, identifier, name, created_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(scope, identifier) DO NOTHING',
      [crypto.randomUUID(), this.scope, identifier, name, new Date().toISOString()],
    );
    return (
      await this.db.all<WalletRow>('SELECT * FROM wallets WHERE scope = ? AND identifier = ?', [
        this.scope,
        identifier,
      ])
    )[0];
  }
  async snapshot(id: string, value: WalletSnapshot) {
    await this.db.run('UPDATE wallets SET snapshot = ? WHERE id = ? AND scope = ?', [
      JSON.stringify(value),
      id,
      this.scope,
    ]);
  }
  async reserveOperation(walletId: string, id: string, kind: string) {
    await this.db.run(
      'INSERT INTO operations(id, wallet_id, kind, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(wallet_id, id) DO NOTHING',
      [id, walletId, kind, new Date().toISOString()],
    );
  }
  async operation(walletId: string, op: Operation) {
    await this.db.run('UPDATE operations SET result = ? WHERE wallet_id = ? AND id = ?', [
      JSON.stringify(op),
      walletId,
      op.id,
    ]);
  }
  async operations(walletId: string) {
    return this.db.all<OperationRow>(
      'SELECT * FROM operations WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 50',
      [walletId],
    );
  }
  async operationIds(walletId: string) {
    return (
      await this.db.all<{ id: string }>('SELECT id FROM operations WHERE wallet_id = ?', [walletId])
    ).map((r) => r.id);
  }
  async projectSwap(walletId: string, value: SwapView) {
    await this.db.run(
      `INSERT INTO swap_summaries(wallet_id,id,version,phase,updated_at,summary) VALUES(?,?,?,?,?,?)
      ON CONFLICT(wallet_id,id) DO UPDATE SET version=excluded.version,phase=excluded.phase,updated_at=excluded.updated_at,summary=excluded.summary
      WHERE excluded.version > swap_summaries.version`,
      [walletId, value.id, value.version, value.phase, value.updatedAt, JSON.stringify(value)],
    );
  }
  async quoteAllowed(walletId: string, now = Date.now()) {
    await this.db.run(
      `INSERT INTO swap_quote_limits VALUES(?,1,?) ON CONFLICT(wallet_id) DO UPDATE SET
      count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END`,
      [walletId, now + 60_000, now, now],
    );
    const [row] = await this.db.all<{ count: number }>(
      'SELECT count FROM swap_quote_limits WHERE wallet_id = ?',
      [walletId],
    );
    return row.count <= 12;
  }
  async audit(walletId: string | null, action: string, outcome: string) {
    await this.db.run('INSERT INTO audit_events VALUES(?, ?, ?, ?, ?)', [
      crypto.randomUUID(),
      walletId,
      action,
      outcome,
      new Date().toISOString(),
    ]);
  }
}
export class SqlStateStore implements StateStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly namespace: string,
  ) {}
  async read(key: string) {
    return (
      (
        await this.db.all<{ value: string }>(
          'SELECT value FROM local_wallet_state WHERE namespace = ? AND key = ?',
          [this.namespace, key],
        )
      )[0]?.value ?? null
    );
  }
  write(key: string, value: string) {
    return this.db.run(
      'INSERT INTO local_wallet_state VALUES(?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value',
      [this.namespace, key, value],
    );
  }
}
