import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { SerialExecutor } from '@oms/server-wallet-sdk';
import { createApp } from './app.js';
import { configFrom, scopeFor } from './config.js';
import { Repository, SqlStateStore, type SqlDatabase } from './database.js';
import { processCommand } from './service.js';

const filename = resolve(process.env.DATABASE_PATH ?? '.data/dashboard.sqlite');
mkdirSync(dirname(filename), { recursive: true });
const sqlite = new DatabaseSync(filename);
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const version = sqlite.prepare('PRAGMA user_version').get()?.user_version;
if (version === 0)
  sqlite.exec(
    `BEGIN; ${readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8')} PRAGMA user_version = 1; COMMIT;`,
  );
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
const executors = new Map<string, SerialExecutor>();
const app = createApp({
  config,
  repo: new Repository(db, scope),
  dispatch: (row, command) => {
    let executor = executors.get(row.id);
    if (!executor) {
      executor = new SerialExecutor();
      executors.set(row.id, executor);
    }
    return processCommand(
      config,
      row.identifier,
      new SqlStateStore(db, `${scope}:${row.id}`),
      executor,
      command,
    );
  },
});
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 8787 }, () =>
  console.log('OMS dashboard API: http://127.0.0.1:8787 (Node + SQLite)'),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () =>
    server.close(() => {
      sqlite.close();
      process.exit(0);
    }),
  );
