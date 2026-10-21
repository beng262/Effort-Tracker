import { DEFAULT_DAY_HOURS, fold, isLeave, isoWeekday, parseDate, parseHours, parseRange, type DateContext } from './turkish.js';
import { CATEGORIES, canonicalCategory } from './standard.js';
import type { Flag, NormalisedRow, ProposedRow, RowExtras } from './types.js';

export interface NormaliseOptions extends DateContext {
  today: string;
  dayHours?: number;
  /** Keys of rows already saved for this person: `${date}|${hours}|${folded description}`. */
  existingKeys?: Set<string>;
  /** Dates before this are in a closed period. */
  closedBefore?: string;
  maxDayHours?: number;
}

export interface NormaliseResult {
  rows: NormalisedRow[];
  /** Human-readable notes for lines that were dropped, e.g. leave days. */
  notes: string[];
}

export function rowKey(date: string | null, hours: number | null, description: string): string {
  return `${date ?? ''}|${hours ?? ''}|${fold(description)}`;
}

const squash = (s: string) => fold(s).replace(/\s+/g, '');

/** Every digit group the model claims must literally appear in the text it cites. */
function tracesToSource(claimed: string | null, sourceText: string): boolean {
  if (!claimed) return true;
  const src = squash(sourceText);
  if (src.includes(squash(claimed))) return true;
  const nums = claimed.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return nums.every((n) => src.includes(n.replace(',', '.')) || src.includes(n.replace('.', ',')));
}

export function normalise(rows: (ProposedRow & { extras?: RowExtras; employee?: string | null })[], opts: NormaliseOptions): NormaliseResult {
  const dayHours = opts.dayHours ?? DEFAULT_DAY_HOURS;
  const maxDay = opts.maxDayHours ?? 10;
  const notes: string[] = [];
  const out: NormalisedRow[] = [];
  const seen = new Set<string>(opts.existingKeys ?? []);

  for (const p of rows) {
    const flags: Flag[] = [];
    const description = p.description.trim();
    const hasEffortWords = !!(p.effort && /\d/.test(p.effort)) || !!(p.time && /\d/.test(p.time));
    if (p.leave || (!hasEffortWords && isLeave(`${p.description} ${p.source_text}`))) {
      notes.push(`İzin satırı atlandı (${p.source}): ${p.source_text.slice(0, 60)}`);
      continue;
    }

    const date = p.date ? parseDate(p.date, opts) : null;
    if (!date) flags.push('no_date');

    let start: string | null = null;
    let end: string | null = null;
    let hours: number | null = null;
    let rule: string | null = null;

    const range = p.time ? parseRange(p.time) : null;
    if (range) { start = range.start; end = range.end; }

    const fromEffort = p.effort ? parseHours(p.effort, dayHours) : null;
    if (fromEffort) { hours = fromEffort.hours; rule = fromEffort.rule; }
    else if (range) { hours = range.hours; rule = 'range'; }
    if (hours === null) flags.push('no_effort');
    else if (hours <= 0) flags.push('zero_effort');

    if (!tracesToSource(p.effort, p.source_text) || !tracesToSource(p.time && range ? p.time : null, p.source_text)) {
      flags.push('number_not_in_source');
    }
    if (p.confidence < 0.6) flags.push('low_confidence');

    // The standard form's rules: entries in 15-minute steps; a customer or "İç Çalışma" on every row; one of the six categories.
    if (p.extras) {
      if (hours !== null && hours > 0 && Math.abs(hours * 4 - Math.round(hours * 4)) > 0.02) flags.push('not_quarter_hour');
      if (!p.extras.customer) flags.push('no_customer');
      if (p.extras.category && !canonicalCategory(p.extras.category)) flags.push('unknown_category');
      else if (!p.extras.category) flags.push('unknown_category');
    }

    if (date) {
      if (date > opts.today) flags.push('future_date');
      if (isoWeekday(date) >= 5) flags.push('weekend');
      if (opts.closedBefore && date < opts.closedBefore) flags.push('closed_period');
    }

    const key = rowKey(date, hours, description);
    if (date && hours !== null && seen.has(key)) flags.push('duplicate');
    else seen.add(key);

    out.push({
      date, startTime: start, endTime: end, hours, hoursRule: rule, description,
      taskHint: p.task_hint, ticketHint: p.ticket_hint, projectHint: p.project_hint,
      confidence: p.confidence, source: p.source, sourceText: p.source_text, flags,
      ...(p.extras ? { extras: p.extras } : {}), ...(p.employee !== undefined ? { employee: p.employee } : {}),
    });
  }

  // Day totals are only known once every row has been read.
  const perDay = new Map<string, number>();
  for (const r of out) if (r.date && r.hours && !r.flags.includes('duplicate')) perDay.set(r.date, (perDay.get(r.date) ?? 0) + r.hours);
  for (const r of out) if (r.date && (perDay.get(r.date) ?? 0) > maxDay) r.flags.push('over_10h_day');

  return { rows: out, notes };
}

/** Rows that block saving until the person has looked at them. */
export const BLOCKING_FLAGS: Flag[] = ['no_date', 'no_effort', 'zero_effort', 'number_not_in_source', 'closed_period', 'duplicate'];

export function isBlocking(r: NormalisedRow): boolean {
  return r.flags.some((f) => BLOCKING_FLAGS.includes(f));
}
