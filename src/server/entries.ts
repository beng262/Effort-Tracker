import { isoWeekday, addDays, mondayOf, parseDate, parseHours, parseClock, formatClock } from '../core/turkish.js';
import { CATEGORIES, canonicalCategory } from '../core/standard.js';
import { audit } from './access.js';
import { recomputeDay, recomputeDays } from './overtime.js';
import type { Ctx } from './context.js';
import type { Db } from './db.js';
import { closedBefore } from './pipeline.js';

export interface EntryRow {
  id: string; employee_id: string; project_id: string | null; upload_id: string | null;
  work_date: string | null; start_time: string | null; end_time: string | null; hours: number | null; hours_rule: string | null;
  description: string; link_kind: 'planner' | 'itsm' | null; link_id: string | null; link_tenant: string | null; link_score: number | null; link_via: string | null;
  link_options: unknown; flags: string[]; confidence: number | null; source: string | null; source_text: string | null;
  status: 'draft' | 'confirmed' | 'approved'; origin: string; created_at: string;
}

export class EntryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Flags that depend on the other rows or today's date are recomputed after every change. */
export async function recomputeFlags(db: Db, entryId: string, today: string, keep: string[] = []): Promise<string[]> {
  const e = (await db.query<EntryRow>('SELECT * FROM entries WHERE id=$1', [entryId])).rows[0];
  if (!e) return [];
  const flags: string[] = [...keep];
  if (!e.work_date) flags.push('no_date');
  if (e.hours === null) flags.push('no_effort');
  else if (e.hours <= 0) flags.push('zero_effort');
  if (e.confidence !== null && e.confidence < 0.6 && keep.includes('low_confidence')) { /* kept */ }
  if (e.work_date) {
    if (e.work_date > today) flags.push('future_date');
    if (isoWeekday(e.work_date) >= 5) flags.push('weekend');
    const cb = await closedBefore(db);
    if (cb && e.work_date < cb) flags.push('closed_period');
    if (e.hours !== null) {
      const dup = await db.query(
        `SELECT 1 FROM entries WHERE employee_id=$1 AND work_date=$2 AND hours=$3 AND lower(description)=lower($4) AND id<>$5 AND NOT deleted
           AND (status <> 'draft' OR (upload_id IS NOT DISTINCT FROM $6 AND id < $5)) LIMIT 1`,
        [e.employee_id, e.work_date, e.hours, e.description, e.id, e.upload_id]);
      if (dup.rows.length) flags.push('duplicate');
      const total = (await db.query<{ t: number }>(`SELECT coalesce(sum(hours),0) AS t FROM entries WHERE employee_id=$1 AND work_date=$2 AND NOT deleted AND hours IS NOT NULL`, [e.employee_id, e.work_date])).rows[0].t;
      if (total > 10) flags.push('over_10h_day');
    }
  }
  const unique = [...new Set(flags)];
  await db.query('UPDATE entries SET flags=$2 WHERE id=$1', [entryId, unique]);
  return unique;
}

export interface EntryInput {
  date?: string | null;       // ISO, or Turkish text parsed with fixed rules
  start?: string | null;
  end?: string | null;
  hours?: number | string | null; // number, or text such as "2,5 saat" / "yarım gün"
  description?: string;
  projectId?: string | null;
  link?: { kind: 'planner' | 'itsm' | 'project'; id: string; tenantId?: string } | null;
  category?: string | null;
  customer?: string | null;
  workItem?: string | null;
  product?: string | null;
  outcome?: string | null;
  progress?: string | null;
}

function resolveInput(i: EntryInput, dayHours: number, ctx: { today: string }) {
  const out: { date?: string | null; start?: string | null; end?: string | null; hours?: number | null; rule?: string | null } = {};
  if (i.date !== undefined) {
    if (i.date === null || i.date === '') out.date = null;
    else {
      const d = parseDate(i.date, { year: Number(ctx.today.slice(0, 4)), weekStart: mondayOf(ctx.today), month: Number(ctx.today.slice(5, 7)) });
      if (!d) throw new EntryError(`Tarih anlaşılamadı: ${i.date}`);
      out.date = d;
    }
  }
  const clock = (v: string | null | undefined) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const m = parseClock(v);
    if (m === null) throw new EntryError(`Saat anlaşılamadı: ${v}`);
    return formatClock(m);
  };
  const s = clock(i.start); if (s !== undefined) out.start = s;
  const e = clock(i.end); if (e !== undefined) out.end = e;
  if (i.hours !== undefined) {
    if (i.hours === null || i.hours === '') { out.hours = null; out.rule = null; }
    else if (typeof i.hours === 'number') { out.hours = Math.round(i.hours * 100) / 100; out.rule = 'manual'; }
    else {
      const p = parseHours(i.hours, dayHours);
      if (!p) throw new EntryError(`Efor anlaşılamadı: ${i.hours}`);
      out.hours = p.hours; out.rule = p.rule;
    }
    if (out.hours !== null && out.hours !== undefined && (out.hours < 0 || out.hours > 24)) throw new EntryError('Efor 0 ile 24 saat arasında olmalı');
  }
  return out;
}

async function linkFields(db: Db, link: EntryInput['link']): Promise<{ kind: string | null; id: string | null; tenant: string | null; via: string | null }> {
  if (!link) return { kind: null, id: null, tenant: null, via: null };
  // Only a task or ticket that exists in the cache can be linked; ids are never taken on trust.
  if (link.kind === 'planner') {
    const t = (await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM planner_tasks WHERE id=$1 AND ($2::text IS NULL OR tenant_id=$2)`, [link.id, link.tenantId ?? null])).rows[0];
    if (!t) throw new EntryError('Planner görevi bulunamadı');
    return { kind: 'planner', id: link.id, tenant: t.tenant_id, via: 'manual' };
  }
  if (link.kind === 'project') {
    const ok = /^[0-9a-f-]{36}$/i.test(link.id) && (await db.query(`SELECT 1 FROM project_tasks WHERE id=$1`, [link.id])).rows.length > 0;
    if (!ok) throw new EntryError('Proje planı görevi bulunamadı');
    return { kind: 'project', id: link.id, tenant: null, via: 'manual' };
  }
  const k = (await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM itsm_tickets WHERE id=$1`, [link.id])).rows[0];
  if (!k) throw new EntryError('ITSM bileti bulunamadı');
  return { kind: 'itsm', id: link.id, tenant: k.tenant_id, via: 'manual' };
}

const EXTRA_COLS: [keyof EntryInput, string][] = [['category', 'category'], ['customer', 'customer'], ['workItem', 'work_item'], ['product', 'product'], ['outcome', 'outcome'], ['progress', 'progress']];

/** Category must be one of the six (or empty); the other text fields are free but short. */
function cleanExtra(key: string, v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (key === 'category') {
    const c = canonicalCategory(t);
    if (!c) throw new EntryError(`Kategori şunlardan biri olmalı: ${CATEGORIES.join(', ')}`);
    return c;
  }
  return t.slice(0, 300);
}

export async function createEntry(ctx: Ctx, employeeId: string, dayHours: number, i: EntryInput, origin: 'manual' | 'chat' = 'manual'): Promise<EntryRow> {
  const v = resolveInput(i, dayHours, { today: ctx.today() });
  if (!v.date) throw new EntryError('Tarih gerekli');
  if ((v.hours === undefined || v.hours === null) && v.start && v.end) { v.hours = hoursBetween(v.start, v.end); v.rule = 'range'; }
  if (v.hours === undefined || v.hours === null) throw new EntryError('Efor gerekli (süre ya da başlangıç ve bitiş)');
  const l = await linkFields(ctx.db, i.link);
  const id = (await ctx.db.query<{ id: string }>(
    `INSERT INTO entries (employee_id, project_id, work_date, start_time, end_time, hours, hours_rule, description,
       link_kind, link_id, link_tenant, link_via, status, origin, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,1) RETURNING id`,
    [employeeId, i.projectId ?? null, v.date, v.start ?? null, v.end ?? null, v.hours, v.rule ?? 'manual', (i.description ?? '').trim(), l.kind, l.id, l.tenant, l.via, origin])).rows[0].id;
  for (const [k, col] of EXTRA_COLS) if ((i as any)[k] !== undefined) await ctx.db.query(`UPDATE entries SET ${col}=$2 WHERE id=$1`, [id, cleanExtra(k, (i as any)[k])]);
  await recomputeFlags(ctx.db, id, ctx.today());
  await recomputeDay(ctx.db, employeeId, v.date);
  await audit(ctx.db, employeeId, 'entry_create', id, { origin });
  return (await ctx.db.query<EntryRow>('SELECT * FROM entries WHERE id=$1', [id])).rows[0];
}

export async function updateEntry(ctx: Ctx, actorId: string, entryId: string, i: EntryInput, dayHours: number): Promise<EntryRow> {
  const cur = (await ctx.db.query<EntryRow>('SELECT * FROM entries WHERE id=$1 AND NOT deleted', [entryId])).rows[0];
  if (!cur || cur.employee_id !== actorId) throw new EntryError('Kayıt bulunamadı', 404);
  if (cur.status === 'approved') throw new EntryError('Onaylanmış kayıt değiştirilemez', 409);
  const cb = await closedBefore(ctx.db);
  if (cb && cur.work_date && cur.work_date < cb && cur.status !== 'draft') throw new EntryError('Bu dönem kapatılmış', 409);

  const v = resolveInput(i, dayHours, { today: ctx.today() });
  const sets: string[] = [];
  const params: unknown[] = [entryId];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  if (v.date !== undefined) set('work_date', v.date);
  if (v.start !== undefined) set('start_time', v.start);
  if (v.end !== undefined) set('end_time', v.end);
  if (v.hours !== undefined) { set('hours', v.hours); set('hours_rule', v.rule); }
  if (i.description !== undefined) set('description', i.description.trim());
  if (i.projectId !== undefined) set('project_id', i.projectId);
  for (const [k, col] of EXTRA_COLS) if ((i as any)[k] !== undefined) set(col, cleanExtra(k, (i as any)[k]));
  if (i.link !== undefined) {
    const l = await linkFields(ctx.db, i.link);
    set('link_kind', l.kind); set('link_id', l.id); set('link_tenant', l.tenant); set('link_via', l.via);
  }
  if (!sets.length) return cur;
  // A confirmed row that is edited goes back to the person's own confirmation: it stays confirmed
  // (the edit is theirs) but is audited with the old values.
  await ctx.db.query(`UPDATE entries SET ${sets.join(', ')} WHERE id=$1`, params);
  // Retyping the effort or times removes the "not in source" flag; the person is now the source.
  const keep = cur.flags.filter((f) => f === 'low_confidence' || (f === 'number_not_in_source' && v.hours === undefined && v.start === undefined && v.end === undefined));
  await recomputeFlags(ctx.db, entryId, ctx.today(), keep);
  const fresh = (await ctx.db.query<EntryRow>('SELECT work_date FROM entries WHERE id=$1', [entryId])).rows[0];
  await recomputeDays(ctx.db, [{ employeeId: actorId, date: cur.work_date }, { employeeId: actorId, date: fresh?.work_date ?? null }]);
  await audit(ctx.db, actorId, 'entry_edit', entryId, { before: { date: cur.work_date, hours: cur.hours, description: cur.description }, input: i });
  return (await ctx.db.query<EntryRow>('SELECT * FROM entries WHERE id=$1', [entryId])).rows[0];
}

export async function deleteEntry(ctx: Ctx, actorId: string, entryId: string): Promise<void> {
  const cur = (await ctx.db.query<EntryRow>('SELECT * FROM entries WHERE id=$1 AND NOT deleted', [entryId])).rows[0];
  if (!cur || cur.employee_id !== actorId) throw new EntryError('Kayıt bulunamadı', 404);
  if (cur.status === 'approved') throw new EntryError('Onaylanmış kayıt silinemez', 409);
  const cb = await closedBefore(ctx.db);
  if (cb && cur.work_date && cur.work_date < cb && cur.status !== 'draft') throw new EntryError('Bu dönem kapatılmış', 409);
  await ctx.db.query('UPDATE entries SET deleted=true WHERE id=$1', [entryId]);
  await recomputeDay(ctx.db, actorId, cur.work_date);
  await audit(ctx.db, actorId, 'entry_delete', entryId, { date: cur.work_date, hours: cur.hours, description: cur.description });
}

/** Bring back an entry the person deleted a moment ago (the toast's undo). Same rules as deleting. */
export async function restoreEntry(ctx: Ctx, actorId: string, entryId: string): Promise<EntryRow> {
  const cur = (await ctx.db.query<EntryRow & { deleted: boolean }>('SELECT * FROM entries WHERE id=$1', [entryId])).rows[0];
  if (!cur || cur.employee_id !== actorId || !cur.deleted) throw new EntryError('Kayıt bulunamadı', 404);
  const cb = await closedBefore(ctx.db);
  if (cb && cur.work_date && cur.work_date < cb && cur.status !== 'draft') throw new EntryError('Bu dönem kapatılmış', 409);
  await ctx.db.query('UPDATE entries SET deleted=false WHERE id=$1', [entryId]);
  await recomputeFlags(ctx.db, entryId, ctx.today());
  await recomputeDay(ctx.db, actorId, cur.work_date);
  await audit(ctx.db, actorId, 'entry_restore', entryId);
  return (await ctx.db.query<EntryRow>('SELECT * FROM entries WHERE id=$1', [entryId])).rows[0];
}

/** Delete several entries; the ones that cannot be deleted (approved, closed period) are counted, not hidden. */
export async function deleteEntries(ctx: Ctx, actorId: string, ids: string[]): Promise<{ deleted: string[]; skipped: number }> {
  const deleted: string[] = [];
  let skipped = 0;
  for (const id of ids) {
    try { await deleteEntry(ctx, actorId, id); deleted.push(id); } catch (e) { if (e instanceof EntryError) skipped++; else throw e; }
  }
  return { deleted, skipped };
}

/**
 * Remove a whole uploaded file's rows (drafts and saved ones) and the upload from the history.
 * All or nothing: if any row is approved or in a closed period, nothing is deleted.
 */
export async function deleteUpload(ctx: Ctx, actorId: string, uploadId: string): Promise<{ deleted: number }> {
  const up = (await ctx.db.query<{ id: string }>('SELECT id FROM uploads WHERE id=$1 AND employee_id=$2', [uploadId, actorId])).rows[0];
  if (!up) throw new EntryError('Dosya bulunamadı', 404);
  const rows = (await ctx.db.query<{ id: string; status: string; work_date: string | null }>('SELECT id, status, work_date FROM entries WHERE upload_id=$1 AND NOT deleted', [uploadId])).rows;
  const days = rows.map((r) => ({ employeeId: actorId, date: r.work_date }));
  const cb = await closedBefore(ctx.db);
  const locked = rows.filter((r) => r.status === 'approved' || (cb && r.work_date && r.work_date < cb && r.status !== 'draft'));
  if (locked.length) throw new EntryError(`${locked.length} satır onaylanmış ya da kapalı bir döneme ait olduğu için dosya silinemedi.`, 409);
  await ctx.db.tx(async (t) => {
    await t.query('UPDATE entries SET deleted=true WHERE upload_id=$1 AND NOT deleted', [uploadId]);
    await t.query(`UPDATE uploads SET status='discarded' WHERE id=$1`, [uploadId]);
    await audit(t, actorId, 'upload_delete', uploadId, { rows: rows.length });
  });
  await recomputeDays(ctx.db, days);
  return { deleted: rows.length };
}

/** Manual entries are saved directly by the person; they confirm them in the same step. */
export async function confirmEntries(db: Db, employeeId: string, ids: string[]): Promise<number> {
  const r = await db.query(
    `UPDATE entries SET status='confirmed', confirmed_at=now()
      WHERE employee_id=$1 AND id = ANY($2::uuid[]) AND status='draft' AND NOT deleted AND work_date IS NOT NULL AND hours IS NOT NULL
        AND NOT (flags && ARRAY['duplicate','closed_period','zero_effort','no_date','no_effort','number_not_in_source'])
      RETURNING id`, [employeeId, ids]);
  return r.rows.length;
}

/** Hours between two clock times; an end before the start means the work ran past midnight. */
export function hoursBetween(start: string, end: string): number {
  const s = parseClock(start) ?? 0;
  let e = parseClock(end) ?? 0;
  if (e <= s) e += 1440;
  return Math.round(((e - s) / 60) * 100) / 100;
}

export interface WeekView {
  start: string;
  days: { date: string; weekday: number; hours: number; overtime: number; dayOff: boolean; entries: EntryRow[]; missing: boolean }[];
  total: number;
  overtime: number;
}

export async function weekView(db: Db, employeeId: string, anyDayInWeek: string, today: string): Promise<WeekView> {
  const start = mondayOf(anyDayInWeek);
  const end = addDays(start, 6);
  const holidays = new Set((await db.query<{ date: string }>('SELECT date FROM holidays WHERE date BETWEEN $1 AND $2', [start, end])).rows.map((h) => h.date));
  const rows = (await db.query<EntryRow>(
    `SELECT * FROM entries WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND NOT deleted ORDER BY work_date, start_time NULLS LAST, created_at`, [employeeId, start, end])).rows;
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    const entries = rows.filter((r) => r.work_date === date);
    const saved = entries.filter((e) => e.status !== 'draft');
    const hours = saved.reduce((s, e) => s + (e.hours ?? 0), 0);
    const overtime = saved.reduce((s, e) => s + Number((e as any).overtime_hours ?? 0), 0);
    return { date, weekday: i, hours: Math.round(hours * 100) / 100, overtime: Math.round(overtime * 100) / 100, dayOff: i >= 5 || holidays.has(date), entries, missing: i < 5 && !holidays.has(date) && date <= today && entries.length === 0 };
  });
  return { start, days, total: Math.round(days.reduce((s, d) => s + d.hours, 0) * 100) / 100, overtime: Math.round(days.reduce((s, d) => s + d.overtime, 0) * 100) / 100 };
}
