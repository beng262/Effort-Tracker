import { expect, it } from 'vitest';
import { testDb } from './testdb.js';

it('applies the schema and parses numeric and date columns like production', async () => {
  const db = await testDb();
  const e = (await db.query('INSERT INTO employees (name,email) VALUES ($1,$2) RETURNING id, day_hours', ['A', 'a@x.com'])).rows[0];
  expect(e.day_hours).toBe(8);
  await db.query("INSERT INTO entries (employee_id, work_date, hours, description) VALUES ($1,'2026-10-06',3.5,'x')", [e.id]);
  const r = (await db.query('SELECT work_date, hours, flags FROM entries')).rows[0];
  expect(r).toEqual({ work_date: '2026-10-06', hours: 3.5, flags: [] });
});
