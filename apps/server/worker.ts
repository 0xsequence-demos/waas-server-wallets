import { DurableObject } from 'cloudflare:workers';
import { SerialExecutor, sha256, type StateStore } from '@polygonlabs/oms-server-wallet-sdk';
import { createApp } from './app.js';
import { configFrom, scopeFor, type Config } from './config.js';
import { Repository, type SqlDatabase } from './database.js';
import { processCommand, type Command, type CommandResult } from './service.js';
import { authoritySchema, SqlSwapStore } from './swaps-store.js';
import { d1Database } from './sql-adapters.js';

type Secrets = Pick<
  Config,
  | 'ADMIN_PASSWORD'
  | 'SESSION_SECRET'
  | 'ENCRYPTION_KEY'
  | 'OIDC_PRIVATE_JWK'
  | 'OMS_PUBLISHABLE_KEY'
  | 'TRAILS_API_KEY'
  | 'EVM_RPC_URLS'
>;
type Bindings = Env & Secrets;
interface HostMetadata {
  subject: string;
  walletId: string;
  scope: string;
  legacyIds: string[];
}

export class WalletCoordinator extends DurableObject<Bindings> {
  private readonly executor = new SerialExecutor();
  private readonly workflow = new SerialExecutor();
  private readonly entries = new SerialExecutor();
  private readonly db: SqlDatabase;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(authoritySchema);
    this.db = {
      all: async <T extends Record<string, unknown>>(
        sql: string,
        params: (string | number | null)[] = [],
      ) => this.ctx.storage.sql.exec(sql, ...params).toArray() as T[],
      run: async (sql, params = []) => {
        this.ctx.storage.sql.exec(sql, ...params);
      },
    };
  }
  async execute(
    subject: string,
    command: Command,
    walletId = subject,
    legacyIds: string[] = [],
  ): Promise<CommandResult> {
    return this.entries.run(async () => {
      const scope = scopeFor(configFrom(this.env));
      const existing = await this.ctx.storage.get<HostMetadata>('host');
      if (
        existing &&
        (existing.subject !== subject || existing.walletId !== walletId || existing.scope !== scope)
      )
        return {
          ok: false,
          code: 'WALLET_MISMATCH',
          message: 'Wallet coordinator identity does not match.',
          status: 409,
        };
      const host: HostMetadata = {
        subject,
        walletId,
        scope,
        legacyIds: [...new Set([...(existing?.legacyIds ?? []), ...legacyIds])],
      };
      await this.ctx.storage.put('host', host);
      return this.run(host, command);
    });
  }
  private async wake(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, at));
  }
  private async run(host: HostMetadata, command: Command): Promise<CommandResult> {
    const config = configFrom(this.env);
    const raw: StateStore = {
      read: async (key) =>
        (await this.db.all<{ value: string }>('SELECT value FROM state WHERE key = ?', [key]))[0]
          ?.value ?? null,
      write: async (key, value) => {
        await this.db.run(
          'INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          [key, value],
        );
      },
    };
    const store = new SqlSwapStore(
      this.db,
      `${host.scope}:${host.subject}`,
      host.walletId,
      host.subject,
      config.ENCRYPTION_KEY,
      (at) => this.wake(at),
      (event) => console.info(event),
    );
    const result = await processCommand(config, host.subject, raw, this.executor, command, {
      store,
      executor: this.workflow,
      legacyOperationIds: async () => host.legacyIds,
    });
    await store.flush(new Repository(d1Database(this.env.DB), host.scope));
    const next = await store.nextDue();
    if (next !== null)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + (result.ok ? 1000 : 60_000), next));
    else await this.ctx.storage.deleteAlarm();
    return result;
  }
  async alarm() {
    await this.entries.run(async () => {
      // Explicit rearming survives outages beyond the platform's finite automatic retry budget.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const host = await this.ctx.storage.get<HostMetadata>('host');
      if (!host) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (host.scope !== scopeFor(configFrom(this.env))) {
        console.error({ event: 'swap_environment_changed', walletId: host.walletId });
        return;
      }
      try {
        await this.run(host, { kind: 'swap-tick' });
      } catch {
        console.error({ event: 'swap_alarm_retry', walletId: host.walletId });
      }
    });
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
    const config = configFrom(env);
    const scope = scopeFor(config);
    const repo = new Repository(d1Database(env.DB), scope);
    return createApp({
      config,
      repo,
      clientIp: (req) => req.headers.get('CF-Connecting-IP') ?? 'unknown',
      dispatch: async (row, command) => {
        const stub = env.WALLETS.getByName(await sha256(`${scope}:${row.id}`));
        return stub.execute(row.identifier, command, row.id, await repo.operationIds(row.id));
      },
    }).fetch(request);
  },
} satisfies ExportedHandler<Bindings>;
