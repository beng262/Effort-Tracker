import { DEFAULT_WINDOW, fixedHolidays, isWorkingDay, splitDay, type WorkWindow } from '../core/overtime.js';
import { config } from './config.js';
import type { Db } from './db.js';

export const workWindow = (): WorkWindow => ({ start: config.WORK_START ?? DEFAULT_WINDOW.start, end: config.WORK_END ?? DEFAULT_WINDOW.end });

export async function isHoliday(db: Db, date: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM holidays WHERE date=$1', [date])).rows.length > 0;
}

/**
 * Recompute the overtime of one person's day. Called after anything that changes that day: an entry added,
 * edited, deleted or restored. Cheap: a day has a handful of rows.
 */
export async function recomputeDay(db: Db, employeeId: string, date: string | null): Promise<void> {
  if (!date) return;
  const rows = (await db.query<{ id: string; hours: number | null; start_time: string | null; end_time: string | null }>(
    `SELECT id, hours, start_time, end_time FROM entries WHERE employee_id=$1 AND work_date=$2 AND NOT deleted AND hours IS NOT NULL ORDER BY created_at, id`, [employeeId, date])).rows;
  if (!rows.length) return;
  const working = isWorkingDay(date, new Set((await isHoliday(db, date)) ? [date] : []));
  const split = splitDay(rows.map((r) => ({ id: r.id, hours: Number(r.hours), start: r.start_time?.slice(0, 5) ?? null, end: r.end_time?.slice(0, 5) ?? null })), working, workWindow());
  for (const s of split) await db.query('UPDATE entries SET overtime_hours=$2 WHERE id=$1 AND overtime_hours IS DISTINCT FROM $2', [s.id, s.overtime]);
}

export async function recomputeDays(db: Db, pairs: { employeeId: string; date: string | null }[]): Promise<void> {
  const seen = new Set<string>();
  for (const p of pairs) {
    const k = `${p.employeeId}|${p.date}`;
    if (!p.date || seen.has(k)) continue;
    seen.add(k);
    await recomputeDay(db, p.employeeId, p.date);
  }
}

/** A holiday was added or removed: everyone's entries on that date change. */
export async function recomputeDate(db: Db, date: string): Promise<void> {
  const who = (await db.query<{ employee_id: string }>(`SELECT DISTINCT employee_id FROM entries WHERE work_date=$1 AND NOT deleted`, [date])).rows;
  for (const w of who) await recomputeDay(db, w.employee_id, date);
}

/** At start-up: seed the fixed-date holidays for this and next year, and compute overtime for entries saved before this existed. */
export async function prepareOvertime(db: Db, thisYear: number): Promise<{ holidays: number; backfilled: number }> {
  let holidays = 0;
  for (const y of [thisYear, thisYear + 1]) {
    for (const h of fixedHolidays(y)) {
      const r = await db.query('INSERT INTO holidays (date, name) VALUES ($1,$2) ON CONFLICT (date) DO NOTHING RETURNING date', [h.date, h.name]);
      holidays += r.rows.length;
    }
  }
  const done = (await db.query(`SELECT 1 FROM job_runs WHERE name='overtime-backfill'`)).rows.length > 0;
  let backfilled = 0;
  if (!done) {
    const days = (await db.query<{ employee_id: string; d: string }>(`SELECT DISTINCT employee_id, work_date AS d FROM entries WHERE NOT deleted AND work_date IS NOT NULL`)).rows;
    for (const x of days) { await recomputeDay(db, x.employee_id, x.d); backfilled++; }
    await db.query(`INSERT INTO job_runs (name, last_run_at, last_status, last_detail) VALUES ('overtime-backfill', now(), 'ok', $1) ON CONFLICT (name) DO NOTHING`, [String(backfilled)]);
  }
  return { holidays, backfilled };
}
