import { readFileSync, readdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Ordered, transactional upgrades also apply to databases created before swaps existed. */
export function migrate(sqlite: DatabaseSync) {
  const directory = new URL('../../migrations/', import.meta.url);
  const files = readdirSync(directory)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  let version = Number(sqlite.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  for (const file of files) {
    const next = Number(file.slice(0, 4));
    if (next <= version) continue;
    if (next !== version + 1) throw new Error('Missing database migration');
    try {
      sqlite.exec('BEGIN');
      sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
      sqlite.exec(`PRAGMA user_version = ${next}`);
      sqlite.exec('COMMIT');
      version = next;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}
