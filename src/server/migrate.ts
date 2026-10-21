import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(db: Db): Promise<string[]> {
  const dir = join(here, 'sql');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await db.tx(async (t) => {
      await t.exec(readFileSync(join(dir, f), 'utf8'));
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { config } = await import('./config.js');
  const { pgDb } = await import('./db.js');
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const db = pgDb(config.DATABASE_URL);
  console.log('applied:', await migrate(db));
  await db.end();
}
