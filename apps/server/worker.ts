import { DurableObject } from 'cloudflare:workers';
import { SerialExecutor, sha256, type StateStore } from '@polygonlabs/oms-server-wallet-sdk';
import { createApp } from './app.js';
import { configFrom, scopeFor, type Config } from './config.js';
import { Repository, type SqlDatabase } from './database.js';
import { processCommand, type Command } from './service.js';

type Secrets = Pick<
  Config,
  | 'ADMIN_PASSWORD'
  | 'SESSION_SECRET'
  | 'ENCRYPTION_KEY'
  | 'OIDC_PRIVATE_JWK'
  | 'OMS_PUBLISHABLE_KEY'
>;
type Bindings = Env & Secrets;

export class WalletCoordinator extends DurableObject<Bindings> {
  private readonly executor = new SerialExecutor();
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
  }
  async execute(subject: string, command: Command) {
    const store: StateStore = {
      read: async (key) =>
        this.ctx.storage.sql
          .exec<{ value: string }>('SELECT value FROM state WHERE key = ?', key)
          .toArray()[0]?.value ?? null,
      write: async (key, value) => {
        this.ctx.storage.sql.exec(
          'INSERT INTO state VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          value,
        );
      },
    };
    return processCommand(configFrom(this.env), subject, store, this.executor, command);
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (
      !path.startsWith('/api/') &&
      !path.startsWith('/.well-known/') &&
      !path.startsWith('/oidc/')
    )
      return env.ASSETS.fetch(request);
    // Authoritative catalog/session reads, including when D1 read replication is enabled.
    const session = env.DB.withSession('first-primary');
    const db: SqlDatabase = {
      async all<T extends Record<string, unknown>>(
        sql: string,
        params: (string | number | null)[] = [],
      ) {
        const result = await session
          .prepare(sql)
          .bind(...params)
          .all<T>();
        return result.results;
      },
      async run(sql, params = []) {
        await session
          .prepare(sql)
          .bind(...params)
          .run();
      },
    };
    const config = configFrom(env);
    const scope = scopeFor(config);
    return createApp({
      config,
      repo: new Repository(db, scope),
      clientIp: (req) => req.headers.get('CF-Connecting-IP') ?? 'unknown',
      dispatch: async (row, command) => {
        const stub = env.WALLETS.getByName(await sha256(`${scope}:${row.id}`));
        return stub.execute(row.identifier, command);
      },
    }).fetch(request);
  },
} satisfies ExportedHandler<Bindings>;
