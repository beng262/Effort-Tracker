import { PGlite } from '@electric-sql/pglite';
import type { Db } from '../src/server/db.js';
import { migrate } from '../src/server/migrate.js';

/** An in-process Postgres with the real schema, for tests. */
export async function testDb(): Promise<Db> {
  const pg = new PGlite({ parsers: { 1700: (v: string) => parseFloat(v), 1082: (v: string) => v } });
  const wrap = (c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }, inTx = false): Db => ({
    query: async (sql, params) => {
      const r = await c.query(sql, params);
      return { rows: r.rows };
    },
    exec: async (sql) => { await (c as any).exec(sql); },
    tx: async (fn) => {
      if (inTx) return fn(wrap(c, true));
      return pg.transaction((t) => fn(wrap(t as any, true)));
    },
    withLock: async (_n, fn) => fn(),
  });
  const db = wrap(pg as any);
  await migrate(db);
  return db;
}

