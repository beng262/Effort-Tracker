import pg from 'pg';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
  /** Run `fn` only if no other instance holds the named lock. Used so the sync and scheduler run once. */
  withLock<R>(name: string, fn: () => Promise<R>): Promise<R | undefined>;
}

function hash32(s: string): number {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return h;
}

export function pgDb(connectionString: string): Db & { end(): Promise<void> } {
  // Connections stay open for 10 minutes of idleness and use TCP keep-alive: reconnecting to a database in another region is slow.
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 600_000, connectionTimeoutMillis: 10_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  // numeric → number (hours are small); date → 'YYYY-MM-DD' string (no timezone shifts)
  pg.types.setTypeParser(1700, (v) => parseFloat(v));
  pg.types.setTypeParser(1082, (v) => v);
  const wrap = (c: pg.Pool | pg.PoolClient): Db => ({
    query: (sql, params) => c.query(sql, params as any[]) as any,
    exec: async (sql) => { await c.query(sql); },
    tx: async (fn) => {
      const client = 'release' in c ? (c as pg.PoolClient) : await (c as pg.Pool).connect();
      try {
        await client.query('BEGIN');
        const r = await fn(wrap(client));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        if (client !== c) client.release();
      }
    },
    withLock: async (name, fn) => {
      const client = await pool.connect();
      try {
        const k = hash32(name);
        const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [k])).rows[0].ok;
        if (!got) return undefined;
        try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [k]); }
      } finally {
        client.release();
      }
    },
  });
  return Object.assign(wrap(pool), { end: () => pool.end() });
}
