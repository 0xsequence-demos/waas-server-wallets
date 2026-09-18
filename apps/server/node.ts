import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { SerialExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import { createApp } from './app.js';
import { configFrom, scopeFor } from './config.js';
import { Repository, SqlStateStore, type SqlDatabase } from './database.js';
import { processCommand, type Command } from './service.js';
import type { WalletRow } from './database.js';
import { SqlSwapStore } from './swaps-store.js';
import { NodeSwapRunner } from './node-runner.js';
import { migrate } from './migrate.js';

const filename = resolve(process.env.DATABASE_PATH ?? '.data/dashboard.sqlite');
mkdirSync(dirname(filename), { recursive: true });
const sqlite = new DatabaseSync(filename);
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
migrate(sqlite);
const db: SqlDatabase = {
  async all<T extends Record<string, unknown>>(
    sql: string,
    params: (string | number | null)[] = [],
  ) {
    return sqlite.prepare(sql).all(...params) as T[];
  },
  async run(sql, params = []) {
    sqlite.prepare(sql).run(...params);
  },
};
const config = configFrom(process.env);
const scope = scopeFor(config);
const executors = new Map<
  string,
  { credentials: SerialExecutor; workflow: SerialExecutor; entries: SerialExecutor }
>();
const repo = new Repository(db, scope);
const dispatch = (row: WalletRow, command: Command) => {
  let locks = executors.get(row.id);
  if (!locks) {
    locks = {
      credentials: new SerialExecutor(),
      workflow: new SerialExecutor(),
      entries: new SerialExecutor(),
    };
    executors.set(row.id, locks);
  }
  const { credentials, workflow, entries } = locks;
  return entries.run(async () => {
    const store = new SqlSwapStore(
      db,
      `${scope}:${row.identifier}`,
      row.id,
      row.identifier,
      config.ENCRYPTION_KEY,
      undefined,
      (event) => console.info(event),
    );
    const result = await processCommand(
      config,
      row.identifier,
      new SqlStateStore(db, `${scope}:${row.id}`),
      credentials,
      command,
      { store, executor: workflow, legacyOperationIds: () => repo.operationIds(row.id) },
    );
    await store.flush(repo);
    return result;
  });
};
const runner = new NodeSwapRunner(repo, dispatch);
const run = () => {
  void runner.tick().catch(() => console.error({ event: 'swap_runner_unavailable' }));
};
const timer = setInterval(run, 2000);
timer.unref();
run();
const app = createApp({ config, repo, dispatch });
const port = Number(process.env.API_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () =>
  console.log(`OMS dashboard API: http://127.0.0.1:${port} (Node + SQLite)`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => {
      void runner.stop().then(() => {
        sqlite.close();
        process.exit(0);
      });
    });
  });
