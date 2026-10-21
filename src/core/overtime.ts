import { isoWeekday, parseClock } from './turkish.js';

/**
 * Working hours: Monday to Friday, 09:00–18:00, outside public holidays. Everything else is extra overtime
 * ("ekstra mesai"): hours before 09:00 or after 18:00 on a working day, and every hour on a weekend or a holiday.
 */
export interface WorkWindow { start: string; end: string }

export const DEFAULT_WINDOW: WorkWindow = { start: '09:00', end: '18:00' };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isWorkingDay(date: string, holidays: Set<string>): boolean {
  return isoWeekday(date) < 5 && !holidays.has(date);
}

export interface TimedSplit { regular: number; overtime: number }

/**
 * Split one entry that has a start and an end. An end before the start means the work ran past midnight;
 * the part after midnight is always overtime. If the typed hours differ from end−start (rounding, a break),
 * the split is scaled to the typed hours so regular + overtime always equals the hours the person entered.
 */
export function splitTimed(start: string, end: string, hours: number, workingDay: boolean, w: WorkWindow = DEFAULT_WINDOW): TimedSplit {
  const s = parseClock(start);
  const e0 = parseClock(end);
  const w0 = parseClock(w.start);
  const w1 = parseClock(w.end);
  if (s === null || e0 === null || w0 === null || w1 === null) return { regular: hours, overtime: 0 };
  const e = e0 <= s ? e0 + 1440 : e0;
  const total = e - s;
  if (total <= 0) return { regular: hours, overtime: 0 };
  const inside = workingDay ? Math.max(0, Math.min(e, w1) - Math.max(s, w0)) : 0;
  const share = inside / total;
  const regular = round2(hours * share);
  return { regular, overtime: round2(hours - regular) };
}

export interface DayEntry { id: string; hours: number; start: string | null; end: string | null }
export interface DaySplit { id: string; regular: number; overtime: number }

/**
 * All entries of one person on one day, in the order they were created.
 * - Not a working day: everything is overtime.
 * - With times: split by the window.
 * - Hours only (no times): regular until the day's window length (9 h) is used up, the rest is overtime,
 *   because without times there is no other way to tell.
 */
export function splitDay(entries: DayEntry[], workingDay: boolean, w: WorkWindow = DEFAULT_WINDOW): DaySplit[] {
  const w0 = parseClock(w.start) ?? 540;
  const w1 = parseClock(w.end) ?? 1080;
  const capacity = (w1 - w0) / 60;
  const out: DaySplit[] = [];
  let used = 0;
  for (const e of entries.filter((x) => x.start && x.end)) {
    const s = splitTimed(e.start!, e.end!, e.hours, workingDay, w);
    used += s.regular;
    out.push({ id: e.id, ...s });
  }
  let left = Math.max(0, capacity - used);
  for (const e of entries.filter((x) => !(x.start && x.end))) {
    if (!workingDay) { out.push({ id: e.id, regular: 0, overtime: round2(e.hours) }); continue; }
    const regular = round2(Math.min(e.hours, left));
    left = Math.max(0, left - regular);
    out.push({ id: e.id, regular, overtime: round2(e.hours - regular) });
  }
  return out;
}

/** Public holidays with a fixed date, so they can be seeded once. Religious holidays move every year: an admin adds them. */
export function fixedHolidays(year: number): { date: string; name: string }[] {
  const d = (m: number, day: number) => `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return [
    { date: d(1, 1), name: 'Yılbaşı' }, { date: d(4, 23), name: 'Ulusal Egemenlik ve Çocuk Bayramı' }, { date: d(5, 1), name: 'Emek ve Dayanışma Günü' },
    { date: d(5, 19), name: 'Atatürk’ü Anma, Gençlik ve Spor Bayramı' }, { date: d(7, 15), name: 'Demokrasi ve Milli Birlik Günü' },
    { date: d(8, 30), name: 'Zafer Bayramı' }, { date: d(10, 29), name: 'Cumhuriyet Bayramı' },
  ];
}
