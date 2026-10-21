import { z } from 'zod';
import { CATEGORIES } from '../core/standard.js';
import { addDays, isoWeekday, mondayOf } from '../core/turkish.js';
import { entryScope } from './access.js';
import { EntryError } from './entries.js';
import type { Db } from './db.js';
import { atLeast, type User } from './session.js';

export const GROUPS = ['person', 'project', 'task', 'customer', 'tenant', 'link', 'source', 'day', 'week', 'month', 'category', 'entry_customer', 'work_item', 'product'] as const;
export type Group = (typeof GROUPS)[number];

export const definitionSchema = z.object({
  kind: z.enum(['effort', 'missing_days']).default('effort'),
  from: z.string().regex(/^\d{4}-\d\d-\d\d$/),
  to: z.string().regex(/^\d{4}-\d\d-\d\d$/),
  groupBy: z.array(z.enum(GROUPS)).max(3).default([]),
  filters: z.object({
    projectIds: z.array(z.string().uuid()).optional(),
    employeeIds: z.array(z.string().uuid()).optional(),
    customer: z.string().max(200).optional(),
    tenantId: z.string().max(100).optional(),
    linkKind: z.enum(['planner', 'itsm', 'project', 'none']).optional(),
    origin: z.enum(['manual', 'template', 'model', 'chat']).optional(),
    category: z.enum(CATEGORIES).optional(),
    overtimeOnly: z.boolean().optional(),
  }).default({}),
});
export type ReportDefinition = z.infer<typeof definitionSchema>;

// Every dimension is a fixed SQL expression; nothing from a request is ever interpolated.
const DIM: Record<Group, { sql: string; label: string }> = {
  person: { sql: 'emp.name', label: 'Kişi' },
  project: { sql: `coalesce(p.name, '(projesiz)')`, label: 'Proje' },
  task: { sql: `coalesce(pt.title, k.id || ' ' || k.title, pjt.ext_id || ' ' || pjt.title, '(bağlantısız)')`, label: 'Görev / bilet' },
  customer: { sql: `coalesce(k.customer, p.customer, '(müşterisiz)')`, label: 'Müşteri' },
  tenant: { sql: `coalesce(tn.name, '(şirketsiz)')`, label: 'Şirket' },
  link: { sql: `CASE e.link_kind WHEN 'planner' THEN 'Planner' WHEN 'itsm' THEN 'ITSM' WHEN 'project' THEN 'Proje planı' ELSE 'Bağlantısız' END`, label: 'Bağlantı' },
  source: { sql: `e.origin`, label: 'Kaynak' },
  day: { sql: `e.work_date::text`, label: 'Gün' },
  week: { sql: `to_char(date_trunc('week', e.work_date::timestamp), 'YYYY-MM-DD')`, label: 'Hafta (pzt)' },
  month: { sql: `to_char(e.work_date, 'YYYY-MM')`, label: 'Ay' },
  category: { sql: `coalesce(e.category, '(kategorisiz)')`, label: 'Kategori' },
  entry_customer: { sql: `coalesce(e.customer, '(müşterisiz)')`, label: 'Müşteri / İç Çalışma' },
  work_item: { sql: `coalesce(e.work_item, '(adsız)')`, label: 'Proje / SLA / Fırsat' },
  product: { sql: `coalesce(e.product, '(ürünsüz)')`, label: 'Ürün / Teknoloji' },
};

export interface ReportResult {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number>[];
  total: number;
  /** Hours outside 09:00–18:00 on working days, plus all hours on days off. */
  overtime: number;
  entries: number;
  from: string;
  to: string;
  generatedAt: string;
  filters: string[];
  /** The definition that produced this result, so a report started from a preset can be saved. */
  definition: ReportDefinition;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Only confirmed or approved effort is reported; drafts never are. */
export async function runEffortReport(db: Db, user: User, def: ReportDefinition, title = 'Efor raporu'): Promise<ReportResult> {
  const scope = entryScope(user, 'e', 1);
  const params: unknown[] = [...scope.params];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where = [`NOT e.deleted`, `e.status <> 'draft'`, `e.work_date BETWEEN ${p(def.from)} AND ${p(def.to)}`, scope.sql];
  const f = def.filters;
  const desc: string[] = [];
  if (f.projectIds?.length) { where.push(`e.project_id = ANY(${p(f.projectIds)}::uuid[])`); desc.push(`${f.projectIds.length} proje`); }
  if (f.employeeIds?.length) { where.push(`e.employee_id = ANY(${p(f.employeeIds)}::uuid[])`); desc.push(`${f.employeeIds.length} kişi`); }
  if (f.customer) { where.push(`coalesce(e.customer, k.customer, p.customer) = ${p(f.customer)}`); desc.push(`müşteri: ${f.customer}`); }
  if (f.overtimeOnly) { where.push('e.overtime_hours > 0'); desc.push('yalnızca ekstra mesai'); }
  if (f.category) { where.push(`e.category = ${p(f.category)}`); desc.push(`kategori: ${f.category}`); }
  if (f.tenantId) { where.push(`p.tenant_id = ${p(f.tenantId)}`); desc.push(`şirket: ${f.tenantId}`); }
  if (f.linkKind === 'none') { where.push(`e.link_id IS NULL`); desc.push('bağlantısız'); }
  else if (f.linkKind) { where.push(`e.link_kind = ${p(f.linkKind)}`); desc.push(f.linkKind === 'itsm' ? 'ITSM' : f.linkKind === 'project' ? 'Proje planı' : 'Planner'); }
  if (f.origin) { where.push(`e.origin = ${p(f.origin)}`); desc.push(`kaynak: ${f.origin}`); }

  const dims = def.groupBy.map((g) => DIM[g]);
  const select = dims.map((d, i) => `${d.sql} AS g${i}`);
  const from = `FROM entries e
    JOIN employees emp ON emp.id = e.employee_id
    LEFT JOIN projects p ON p.id = e.project_id
    LEFT JOIN tenants tn ON tn.id = p.tenant_id
    LEFT JOIN planner_tasks pt ON e.link_kind = 'planner' AND pt.id = e.link_id AND pt.tenant_id = e.link_tenant
    LEFT JOIN itsm_tickets k ON e.link_kind = 'itsm' AND k.id = e.link_id
    LEFT JOIN project_tasks pjt ON e.link_kind = 'project' AND pjt.id::text = e.link_id
    WHERE ${where.join(' AND ')}`;
  const grp = dims.length ? `GROUP BY ${dims.map((_, i) => `g${i}`).join(', ')} ORDER BY ${dims.map((_, i) => `g${i}`).join(', ')}` : '';
  const sql = `SELECT ${[...select, 'sum(e.hours) AS hours', 'sum(e.overtime_hours) AS overtime', 'count(*)::int AS entries'].join(', ')} ${from} ${grp}`;
  const res = (await db.query<Record<string, any>>(sql, params)).rows;

  const columns = [...dims.map((d, i) => ({ key: `g${i}`, label: d.label })), { key: 'hours', label: 'Saat' }, { key: 'overtime', label: 'Ekstra mesai' }, { key: 'entries', label: 'Kayıt' }];
  const rows: Record<string, any>[] = res.map((r) => ({ ...r, hours: round2(Number(r.hours)), overtime: round2(Number(r.overtime ?? 0)) }));
  return {
    title, columns, rows,
    total: round2(rows.reduce((s, r) => s + Number(r.hours), 0)),
    overtime: round2(rows.reduce((s, r) => s + Number(r.overtime), 0)),
    entries: rows.reduce((s, r) => s + Number(r.entries), 0),
    from: def.from, to: def.to, generatedAt: new Date().toISOString(), filters: desc, definition: def,
  };
}

/** Weekdays in the range up to today on which an active person has no confirmed effort. */
export async function runMissingDays(db: Db, user: User, def: ReportDefinition, today: string): Promise<ReportResult> {
  if (!atLeast(user, 'PM')) throw new EntryError('Eksik gün raporu yalnızca yönetici ve proje yöneticisi içindir', 403);
  const people = (await db.query<{ id: string; name: string }>(
    user.role === 'Admin'
      ? `SELECT id, name FROM employees WHERE active ORDER BY name`
      : `SELECT DISTINCT emp.id, emp.name FROM employees emp JOIN employee_projects ep ON ep.employee_id = emp.id
           JOIN projects pr ON pr.id = ep.project_id WHERE emp.active AND pr.created_by = $1 ORDER BY emp.name`,
    user.role === 'Admin' ? [] : [user.employeeId])).rows;
  const last = def.to < today ? def.to : today;
  const days: string[] = [];
  for (let d = def.from; d <= last; d = addDays(d, 1)) if (isoWeekday(d) < 5) days.push(d);
  const have = (await db.query<{ employee_id: string; d: string }>(
    `SELECT DISTINCT employee_id, work_date AS d FROM entries WHERE NOT deleted AND status <> 'draft' AND work_date BETWEEN $1 AND $2 AND employee_id = ANY($3::uuid[])`,
    [def.from, last, people.map((x) => x.id)])).rows;
  const set = new Set(have.map((h) => `${h.employee_id}|${h.d}`));
  const rows = people
    .map((person) => {
      const missing = days.filter((d) => !set.has(`${person.id}|${d}`));
      return { person: person.name, missing: missing.length, days: missing.map((d) => `${d.slice(8)}.${d.slice(5, 7)}`).join(', ') };
    })
    .filter((r) => r.missing > 0);
  return {
    title: 'Eksik günler',
    columns: [{ key: 'person', label: 'Kişi' }, { key: 'missing', label: 'Eksik gün' }, { key: 'days', label: 'Tarihler' }],
    rows, total: rows.reduce((s, r) => s + r.missing, 0), overtime: 0, entries: rows.length,
    from: def.from, to: last, generatedAt: new Date().toISOString(), filters: ['izin günleri ayrıca işaretlenmez'], definition: def,
  };
}

export async function runReport(db: Db, user: User, def: ReportDefinition, today: string, title?: string): Promise<ReportResult> {
  return def.kind === 'missing_days' ? runMissingDays(db, user, def, today) : runEffortReport(db, user, def, title);
}

export interface Preset { id: string; name: string; minRole: 'Employee' | 'PM'; build(today: string): ReportDefinition }

const monthStart = (d: string) => `${d.slice(0, 8)}01`;

export const PRESETS: Preset[] = [
  { id: 'my-overtime', name: 'Ekstra mesaim (bu ay)', minRole: 'Employee', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['day'], filters: { overtimeOnly: true } }) },
  { id: 'my-week', name: 'Haftam', minRole: 'Employee', build: (t) => ({ kind: 'effort', from: mondayOf(t), to: addDays(mondayOf(t), 6), groupBy: ['day'], filters: {} }) },
  { id: 'my-month', name: 'Bu ay (proje ve görev)', minRole: 'Employee', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['project', 'task'], filters: {} }) },
  { id: 'project-people-weeks', name: 'Proje: kişi ve hafta', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['project', 'person', 'week'], filters: {} }) },
  { id: 'project-tasks', name: 'Proje: görev bazında', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['project', 'task'], filters: {} }) },
  { id: 'customer-billing', name: 'Müşteri efor (faturalama)', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['customer', 'link', 'task'], filters: {} }) },
  { id: 'ticket-effort', name: 'Bilet eforu (Beta)', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['task', 'person'], filters: { linkKind: 'itsm' } }) },
  { id: 'task-progress', name: 'Görev: gerçekleşen efor', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['task'], filters: { linkKind: 'planner' } }) },
  { id: 'missing-days', name: 'Eksik günler', minRole: 'PM', build: (t) => ({ kind: 'missing_days', from: mondayOf(t), to: t, groupBy: [], filters: {} }) },
  { id: 'category-customer', name: 'Kategori ve müşteri eforu', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['category', 'entry_customer'], filters: {} }) },
  { id: 'sla-usage', name: 'SLA tüketimi (müşteri ve iş bazında)', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['entry_customer', 'work_item', 'person'], filters: { category: 'SLA' } }) },
  { id: 'project-effort', name: 'Proje eforu (proje ve kişi bazında)', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['work_item', 'person'], filters: { category: 'Proje' } }) },
  { id: 'product-effort', name: 'Ürün / teknoloji bazında efor', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['product', 'category'], filters: {} }) },
  { id: 'overtime-people', name: 'Ekstra mesai: kişi ve hafta', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['person', 'week'], filters: { overtimeOnly: true } }) },
  { id: 'overtime-days', name: 'Ekstra mesai: gün ve kişi', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['day', 'person'], filters: { overtimeOnly: true } }) },
  { id: 'unlinked', name: 'Bağlantısız saatler', minRole: 'PM', build: (t) => ({ kind: 'effort', from: monthStart(t), to: t, groupBy: ['person', 'project'], filters: { linkKind: 'none' } }) },
];

export function presetsFor(user: User) {
  return PRESETS.filter((p) => p.minRole === 'Employee' || atLeast(user, 'PM')).map(({ id, name }) => ({ id, name }));
}
