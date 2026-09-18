import type { SqlDatabase } from './database.js';
export function d1Database(db: D1Database): SqlDatabase {
  const session = db.withSession('first-primary');
  return {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: (string | number | null)[] = [],
    ) {
      return (
        await session
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results;
    },
    async run(sql, params = []) {
      await session
        .prepare(sql)
        .bind(...params)
        .run();
    },
  };
}
