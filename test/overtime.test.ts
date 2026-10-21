import { beforeAll, describe, expect, it } from 'vitest';
import { fixedHolidays, isWorkingDay, splitDay, splitTimed } from '../src/core/overtime.js';

describe('working day', () => {
  const holidays = new Set(['2026-10-29']);
  it('is Monday to Friday and not a holiday', () => {
    expect(isWorkingDay('2026-10-13', holidays)).toBe(true);  // Tuesday
    expect(isWorkingDay('2026-10-17', holidays)).toBe(false); // Saturday
    expect(isWorkingDay('2026-10-18', holidays)).toBe(false); // Sunday
    expect(isWorkingDay('2026-10-29', holidays)).toBe(false); // Cumhuriyet Bayramı, a Thursday
  });
  it('seeds the fixed-date national holidays', () => {
    expect(fixedHolidays(2026).map((h) => h.date)).toEqual(['2026-01-01', '2026-04-23', '2026-05-01', '2026-05-19', '2026-07-15', '2026-08-30', '2026-10-29']);
  });
});

describe('an entry with times', () => {
  it('is all regular inside 09:00–18:00', () => {
    expect(splitTimed('09:00', '10:30', 1.5, true)).toEqual({ regular: 1.5, overtime: 0 });
    expect(splitTimed('09:00', '18:00', 9, true)).toEqual({ regular: 9, overtime: 0 });
  });
  it('splits at the window edges', () => {
    expect(splitTimed('08:00', '10:00', 2, true)).toEqual({ regular: 1, overtime: 1 });   // 1 h before 09:00
    expect(splitTimed('17:00', '19:30', 2.5, true)).toEqual({ regular: 1, overtime: 1.5 }); // after 18:00
    expect(splitTimed('07:00', '20:00', 13, true)).toEqual({ regular: 9, overtime: 4 });
  });
  it('is all overtime entirely outside the window', () => {
    expect(splitTimed('19:00', '21:00', 2, true)).toEqual({ regular: 0, overtime: 2 });
    expect(splitTimed('06:00', '08:30', 2.5, true)).toEqual({ regular: 0, overtime: 2.5 });
  });
  it('is all overtime on a weekend or holiday, whatever the time', () => {
    expect(splitTimed('10:00', '12:00', 2, false)).toEqual({ regular: 0, overtime: 2 });
  });
  it('treats work past midnight as overtime for the part after midnight', () => {
    expect(splitTimed('17:00', '02:00', 9, true)).toEqual({ regular: 1, overtime: 8 });
    expect(splitTimed('23:00', '01:00', 2, true)).toEqual({ regular: 0, overtime: 2 });
  });
  it('keeps regular + overtime equal to the hours typed, even when they differ from end−start', () => {
    const s = splitTimed('08:00', '10:00', 1.5, true); // typed 1.5 h for a 2 h span (a break)
    expect(s.regular + s.overtime).toBeCloseTo(1.5, 2);
    expect(s).toEqual({ regular: 0.75, overtime: 0.75 });
  });
  it('does not guess when the times cannot be read', () => {
    expect(splitTimed('x', 'y', 3, true)).toEqual({ regular: 3, overtime: 0 });
  });
});

describe('a whole day', () => {
  const e = (id: string, hours: number, start: string | null = null, end: string | null = null) => ({ id, hours, start, end });
  const by = (r: ReturnType<typeof splitDay>) => Object.fromEntries(r.map((x) => [x.id, [x.regular, x.overtime]]));

  it('counts hours-only entries as regular up to the 9 hours of the window, then overtime', () => {
    expect(by(splitDay([e('a', 4), e('b', 4), e('c', 3)], true))).toEqual({ a: [4, 0], b: [4, 0], c: [1, 2] });
  });
  it('uses the timed entries first, so untimed ones only get what is left of the window', () => {
    // 6 h timed inside the window leave 3 h; the untimed 5 h is 3 regular + 2 overtime
    expect(by(splitDay([e('untimed', 5), e('timed', 6, '09:00', '15:00')], true))).toEqual({ timed: [6, 0], untimed: [3, 2] });
  });
  it('is all overtime on a day off', () => {
    expect(by(splitDay([e('a', 3), e('b', 2, '10:00', '12:00')], false))).toEqual({ a: [0, 3], b: [0, 2] });
  });
  it('a custom window changes the capacity and the edges', () => {
    const w = { start: '08:00', end: '17:00' };
    expect(splitTimed('16:00', '18:00', 2, true, w)).toEqual({ regular: 1, overtime: 1 });
    expect(by(splitDay([e('a', 10)], true, w))).toEqual({ a: [9, 1] });
  });
});

/* ---------- in the app ---------- */

import { testDb } from './testdb.js';
import type { Db } from '../src/server/db.js';
import { createEntry, deleteEntry, restoreEntry, updateEntry, weekView } from '../src/server/entries.js';
import { prepareOvertime, recomputeDate } from '../src/server/overtime.js';
import { runEffortReport, definitionSchema } from '../src/server/reports.js';

describe('overtime in the app', () => {
  let db: Db;
  let emp: string;
  const ctx = () => ({ db, ai: {} as any, blob: {} as any, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-23' }) as any;
  const ot = async (id: string) => Number((await db.query('SELECT overtime_hours FROM entries WHERE id=$1', [id])).rows[0].overtime_hours);
  const make = (date: string, extra: object) => createEntry(ctx(), emp, 8, { date, description: 'x', ...extra } as any);

  beforeAll(async () => {
    db = await testDb();
    emp = (await db.query(`INSERT INTO employees (name,email,role) VALUES ('Murat','m@x.com','Admin') RETURNING id`)).rows[0].id;
    const seeded = await prepareOvertime(db, 2026);
    expect(seeded.holidays).toBeGreaterThan(10); // 2026 and 2027 fixed holidays
  });

  it('works out hours from a start and an end, and the overtime outside 09:00–18:00', async () => {
    const e = await make('2026-10-20', { start: '17:00', end: '20:30' }); // Tuesday
    expect(e.hours).toBe(3.5);
    expect(await ot(e.id)).toBe(2.5);
  });

  it('a typed duration with no times counts as regular up to 9 h a day, the rest as overtime', async () => {
    const a = await make('2026-10-21', { hours: 5 });
    const b = await make('2026-10-21', { hours: 6 });
    expect([await ot(a.id), await ot(b.id)]).toEqual([0, 2]); // 5 + 4 regular, 2 over
    await deleteEntry(ctx(), emp, a.id);
    expect(await ot(b.id)).toBe(0); // deleting one gives the room back
    await restoreEntry(ctx(), emp, a.id);
    expect([await ot(a.id), await ot(b.id)]).toEqual([0, 2]);
  });

  it('everything on a weekend is overtime, and moving an entry to a weekday recalculates it', async () => {
    const e = await make('2026-10-24', { hours: 4 }); // Saturday
    expect(await ot(e.id)).toBe(4);
    await updateEntry(ctx(), emp, e.id, { date: '2026-10-22' }, 8);
    expect(await ot(e.id)).toBe(0);
  });

  it('a holiday turns the whole day into overtime, for everyone, and removing it turns it back', async () => {
    const e = await make('2026-10-29', { hours: 3 }); // Cumhuriyet Bayramı (seeded), a Thursday
    expect(await ot(e.id)).toBe(3);
    await db.query(`DELETE FROM holidays WHERE date='2026-10-29'`);
    await recomputeDate(db, '2026-10-29');
    expect(await ot(e.id)).toBe(0);
    await db.query(`INSERT INTO holidays (date, name) VALUES ('2026-10-29','Cumhuriyet Bayramı')`);
    await recomputeDate(db, '2026-10-29');
    expect(await ot(e.id)).toBe(3);
  });

  it('the week view and the reports carry the overtime', async () => {
    await db.query(`UPDATE entries SET status='confirmed'`);
    const w = await weekView(db, emp, '2026-10-20', '2026-10-23');
    expect(w.overtime).toBe(2.5 + 2); // Tuesday 17:00–20:30, plus the Wednesday overflow
    expect(w.days.find((d) => d.date === '2026-10-24')?.dayOff).toBe(true);
    const admin = { employeeId: emp, name: 'Murat', email: 'm@x.com', role: 'Admin' as const, dayHours: 8 };
    const all = await runEffortReport(db, admin, definitionSchema.parse({ from: '2026-10-01', to: '2026-10-31', groupBy: [] }));
    expect(all.overtime).toBe(2.5 + 2 + 3);
    expect(all.columns.map((c) => c.key)).toEqual(['hours', 'overtime', 'entries']);
    const only = await runEffortReport(db, admin, definitionSchema.parse({ from: '2026-10-01', to: '2026-10-31', groupBy: ['day'], filters: { overtimeOnly: true } }));
    expect(only.rows.map((r) => r.g0)).toEqual(['2026-10-20', '2026-10-21', '2026-10-29']);
    expect(only.filters).toContain('yalnızca ekstra mesai');
  });

  it('entries saved before overtime existed are backfilled once at start-up', async () => {
    const d2 = await testDb();
    const e = (await d2.query(`INSERT INTO employees (name,email) VALUES ('Eski','e@x.com') RETURNING id`)).rows[0].id;
    await d2.query(`INSERT INTO entries (employee_id, work_date, start_time, end_time, hours, description, status) VALUES ($1,'2026-10-20','19:00','21:00',2,'eski','confirmed')`, [e]);
    expect((await prepareOvertime(d2, 2026)).backfilled).toBe(1);
    expect(Number((await d2.query('SELECT overtime_hours FROM entries')).rows[0].overtime_hours)).toBe(2);
    expect((await prepareOvertime(d2, 2026)).backfilled).toBe(0); // not again
  });
});
