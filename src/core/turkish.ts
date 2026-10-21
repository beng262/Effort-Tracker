// Deterministic parsing of Turkish dates, weekdays, hours and time ranges.
// The model only proposes text; every number that is saved goes through here.

export const DEFAULT_DAY_HOURS = 8;

/** Lower-case with Turkish rules, then fold diacritics so "Çrş", "çrş" and "crs" compare equal. */
export function fold(s: string): string {
  return s
    .toLocaleLowerCase('tr')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/̇/g, '')
    .trim();
}

const MONTHS: Record<string, number> = {
  ocak: 1, oca: 1, subat: 2, sub: 2, mart: 3, mar: 3, nisan: 4, nis: 4, mayis: 5, may: 5,
  haziran: 6, haz: 6, temmuz: 7, tem: 7, agustos: 8, agu: 8, eylul: 9, eyl: 9,
  ekim: 10, eki: 10, kasim: 11, kas: 11, aralik: 12, ara: 12,
};

// Monday = 0 … Sunday = 6 (keys are folded: no diacritics)
const WEEKDAYS: Record<string, number> = {
  pzt: 0, pazartesi: 0, pt: 0,
  sali: 1, sal: 1,
  carsamba: 2, crs: 2, car: 2, crsb: 2,
  persembe: 3, per: 3, prs: 3,
  cuma: 4, cum: 4,
  cumartesi: 5, cmt: 5,
  pazar: 6, paz: 6,
};

export function weekdayIndex(token: string): number | null {
  const t = fold(token).replace(/[.,]/g, '');
  return t in WEEKDAYS ? WEEKDAYS[t] : null;
}

export interface IsoDate { y: number; m: number; d: number }

export function toIso({ y, m, d }: IsoDate): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isValidDate({ y, m, d }: IsoDate): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return toIso({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

/** 0 = Monday … 6 = Sunday */
export function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function mondayOf(iso: string): string {
  return addDays(iso, -isoWeekday(iso));
}

/** Monday of ISO week `week` of `year`. */
export function mondayOfIsoWeek(year: number, week: number): string {
  const jan4 = toIso({ y: year, m: 1, d: 4 });
  return addDays(mondayOf(jan4), (week - 1) * 7);
}

export interface DateContext {
  /** Monday of the week the file is about, when known (from the file name or the upload date). */
  weekStart?: string;
  /** Year assumed for dates written without one. */
  year: number;
  /** Month assumed for a bare day number such as "12". */
  month?: number;
  /** Today, so "bugün" and "dün" can be resolved. */
  today?: string;
}

/**
 * Find the week a file is about from its name ("hafta41", "hafta 41", "w41", "2026-W41") or,
 * failing that, the Monday of the week before the upload date.
 */
export function weekFromFileName(name: string, uploadDate: string): string {
  const base = fold(name).replace(/\.[a-z0-9]+$/, '');
  const yearMatch = base.match(/(20\d\d)/);
  const year = yearMatch ? Number(yearMatch[1]) : Number(uploadDate.slice(0, 4));
  const m = base.match(/(?:hafta|hft|week|w)[\s_\-]*(\d{1,2})\b/) ?? base.match(/\b(\d{1,2})[\s_\-]*(?:\.\s*)?hafta/);
  if (m) {
    const w = Number(m[1]);
    if (w >= 1 && w <= 53) return mondayOfIsoWeek(year, w);
  }
  return mondayOf(uploadDate);
}

/**
 * Parse a date or weekday written in Turkish. Returns an ISO date or null.
 * Weekdays resolve inside `ctx.weekStart`; a bare day-of-month needs `ctx.month`.
 */
export function parseDate(raw: string, ctx: DateContext): string | null {
  const s = fold(raw).replace(/\s+/g, ' ');
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const d = { y: +m[1], m: +m[2], d: +m[3] };
    return isValidDate(d) ? toIso(d) : null;
  }
  if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/))) {
    let y = m[3] ? +m[3] : ctx.year;
    if (y < 100) y += 2000;
    const d = { y, m: +m[2], d: +m[1] };
    return isValidDate(d) ? toIso(d) : null;
  }
  if ((m = s.match(/^(\d{1,2})\s+([a-z]+)\.?(?:\s+(\d{4}))?(?:\s+[a-z]+)?$/)) && m[2] in MONTHS) {
    const d = { y: m[3] ? +m[3] : ctx.year, m: MONTHS[m[2]], d: +m[1] };
    return isValidDate(d) ? toIso(d) : null;
  }
  // "12 ekim pazartesi", "pzt 12.10"
  const parts = s.split(' ');
  if (parts.length > 1) {
    for (const p of parts) {
      const direct = parseDate(p, ctx);
      if (direct && /\d/.test(p)) return direct;
    }
    // Drop weekday words ("12 ekim pazartesi") and retry, but only when that actually shortens the text.
    const rest = parts.filter((p) => weekdayIndex(p) === null);
    if (rest.length > 0 && rest.length < parts.length) {
      const joined = parseDate(rest.join(' '), ctx);
      if (joined) return joined;
    }
  }
  if (ctx.today) {
    if (s === 'bugun' || s === 'today') return ctx.today;
    if (s === 'dun' || s === 'yesterday') return addDays(ctx.today, -1);
    if (s === 'evvelsi gun' || s === 'evvelki gun' || s === 'onceki gun') return addDays(ctx.today, -2);
  }
  const wd = weekdayIndex(s);
  if (wd !== null && ctx.weekStart) return addDays(ctx.weekStart, wd);
  if ((m = s.match(/^(\d{1,2})$/)) && ctx.month) {
    const d = { y: ctx.year, m: ctx.month, d: +m[1] };
    return isValidDate(d) ? toIso(d) : null;
  }
  return null;
}

export interface ParsedHours {
  hours: number;
  /** What the text said, so a reviewer can see why this number was produced. */
  rule: 'decimal' | 'hm' | 'minutes' | 'days' | 'half-day' | 'range';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function num(s: string): number {
  return parseFloat(s.replace(',', '.'));
}

/** "09:00", "9", "9.30", "0930" → minutes since midnight. */
export function parseClock(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  const h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

export function formatClock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export interface TimeRange { start: string; end: string; hours: number }

/** "09:00-12:30", "09–12:30", "9.30 - 17:00". An end before the start is an overnight shift. */
export function parseRange(raw: string): TimeRange | null {
  const m = raw.trim().match(/^(\d{1,2}(?:[:.]\d{2})?)\s*(?:-|–|—|\/|ile|to)\s*(\d{1,2}(?:[:.]\d{2})?)$/i);
  if (!m) return null;
  const a = parseClock(m[1]);
  const b = parseClock(m[2]);
  if (a === null || b === null || a === b) return null;
  const diff = b > a ? b - a : b + 24 * 60 - a;
  return { start: formatClock(a % (24 * 60)), end: formatClock(b % (24 * 60)), hours: round2(diff / 60) };
}

/**
 * Turkish effort expressions → hours. Fixed rules only:
 * "3s", "3 saat", "2,5 saat", "2s30dk", "90 dk", "yarım gün", "1 gün", "1 adam/gün", "09:00-12:30".
 */
export function parseHours(raw: string, dayHours = DEFAULT_DAY_HOURS): ParsedHours | null {
  const s = fold(raw).replace(/\s+/g, ' ');
  if (!s) return null;

  const range = parseRange(s);
  if (range) return { hours: range.hours, rule: 'range' };

  if (/^(yarim|1\/2|0[.,]5)\s*(adam\s*[\/-]?\s*)?gun$/.test(s) || s === 'yarim gun' || s === 'half day') {
    return { hours: round2(dayHours / 2), rule: 'half-day' };
  }
  if (s === 'tam gun' || s === 'full day') return { hours: dayHours, rule: 'days' };

  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:adam\s*[\/-]?\s*)?(?:gun|g|gunluk|md|man-?day)$/))) {
    return { hours: round2(num(m[1]) * dayHours), rule: 'days' };
  }
  // 2s30dk, 2 saat 30 dk, 2h30m
  if ((m = s.match(/^(\d+)\s*(?:saat|sa|s|h)\s*(\d+)\s*(?:dakika|dk|d|m|min)?$/))) {
    return { hours: round2(+m[1] + +m[2] / 60), rule: 'hm' };
  }
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:saat|sa|s|h|hr|hrs|hour|hours)$/))) {
    return { hours: round2(num(m[1])), rule: 'decimal' };
  }
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:dakika|dk|d|m|min)$/))) {
    return { hours: round2(num(m[1]) / 60), rule: 'minutes' };
  }
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    // "2:30" as a duration
    return { hours: round2(+m[1] + +m[2] / 60), rule: 'hm' };
  }
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) {
    // A bare number in an effort column is hours.
    return { hours: round2(num(m[1])), rule: 'decimal' };
  }
  return null;
}

/** Words that mean "this day was leave", so no effort row is made. */
export function isLeave(raw: string): boolean {
  const s = fold(raw);
  return /\b(izin|yillik izin|raporlu|rapor|tatil|bayram|resmi tatil|off|leave)\b/.test(s) && !/\d\s*(s|saat|dk)/.test(s);
}
