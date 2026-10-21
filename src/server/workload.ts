import { fold } from '../core/turkish.js';
import type { Db } from './db.js';
import { atLeast, type User } from './session.js';

/** Status words that mean a ticket is no longer open (cloud and local names). */
export const CLOSED_STATUS = '(resolved|closed|cancel|complete|çözül|kapal|kapat|iptal|tamam)';

/**
 * Whose work a person may ask about. Admin: everyone, including technicians who have no account here.
 * PM: themselves and the people on projects they created. Employee: nobody (they use their own pages).
 */
export async function visiblePeople(db: Db, user: User): Promise<string[] | null> {
  if (user.role === 'Admin') return null;
  if (!atLeast(user, 'PM')) return [user.employeeId];
  const r = await db.query<{ id: string }>(
    `SELECT DISTINCT ep.employee_id AS id FROM employee_projects ep JOIN projects p ON p.id = ep.project_id WHERE p.created_by = $1 AND p.active`, [user.employeeId]);
  return [...new Set([user.employeeId, ...r.rows.map((x) => x.id)])];
}

interface TicketRow { id: string; title: string; customer: string | null; status: string | null; assignee: string | null; assignee_name: string | null; age_days: number | null }

const TICKETS_SQL = `
  SELECT k.id, k.title, k.customer, k.status, k.assignee, e.name AS assignee_name, e.id AS employee_id,
         floor(extract(epoch FROM now() - k.opened_at) / 86400)::int AS age_days
    FROM itsm_tickets k
    LEFT JOIN LATERAL (SELECT e2.id, e2.name FROM identities i JOIN employees e2 ON e2.id = i.employee_id WHERE lower(i.email) = k.assignee LIMIT 1) e ON true`;

const people = (ids: string[] | null, idx: number) => (ids ? ` AND e.id = ANY($${idx}::uuid[])` : '');

export interface TicketFilter { assignee?: string | null; customer?: string | null; onlyOpen?: boolean; limit?: number }

export async function openTickets(db: Db, user: User, f: TicketFilter = {}) {
  const scope = await visiblePeople(db, user);
  const params: unknown[] = [CLOSED_STATUS];
  let where = f.onlyOpen === false ? 'TRUE' : `k.closed_at IS NULL AND coalesce(k.status, '') !~* $1`;
  if (f.onlyOpen === false) params.length = 0;
  if (scope) { params.push(scope); where += people(scope, params.length); }
  const rows = (await db.query<TicketRow & { employee_id: string | null }>(`${TICKETS_SQL} WHERE ${where} ORDER BY k.opened_at ASC NULLS LAST`, params)).rows;

  const a = f.assignee ? fold(f.assignee) : null;
  const c = f.customer ? fold(f.customer) : null;
  const picked = rows.filter((r) =>
    (!a || fold(`${r.assignee_name ?? ''} ${r.assignee ?? ''}`).includes(a)) && (!c || fold(r.customer ?? '').includes(c)));

  const byPerson = new Map<string, number>();
  for (const r of picked) byPerson.set(r.assignee_name ?? r.assignee ?? 'atanmamış', (byPerson.get(r.assignee_name ?? r.assignee ?? 'atanmamış') ?? 0) + 1);
  const limit = Math.min(f.limit ?? 40, 500);
  return {
    toplam_acik: picked.length,
    kisi_bazinda: [...byPerson].map(([kisi, adet]) => ({ kisi, adet })).sort((x, y) => y.adet - x.adet),
    biletler: picked.slice(0, limit).map((r) => ({ no: r.id, konu: r.title, musteri: r.customer, durum: r.status, sorumlu: r.assignee_name ?? r.assignee ?? 'atanmamış', yas_gun: r.age_days })),
    gosterilmeyen: Math.max(0, picked.length - limit),
  };
}

export type StatGroup = 'technician' | 'customer' | 'status';

/** Ticket counts for reports: how many, grouped by technician, customer or status. */
export async function ticketStats(db: Db, user: User, groupBy: StatGroup, onlyOpen = true) {
  const t = await openTickets(db, user, { onlyOpen, limit: 1 });
  const scope = await visiblePeople(db, user);
  const params: unknown[] = onlyOpen ? [CLOSED_STATUS] : [];
  let where = onlyOpen ? `k.closed_at IS NULL AND coalesce(k.status, '') !~* $1` : 'TRUE';
  if (scope) { params.push(scope); where += people(scope, params.length); }
  const col = { technician: `coalesce(e.name, k.assignee, 'atanmamış')`, customer: `coalesce(k.customer, '(müşterisiz)')`, status: `coalesce(k.status, '(durumsuz)')` }[groupBy];
  const rows = (await db.query<{ g: string; n: number }>(`SELECT ${col} AS g, count(*)::int AS n FROM itsm_tickets k LEFT JOIN LATERAL (SELECT e2.id, e2.name FROM identities i JOIN employees e2 ON e2.id = i.employee_id WHERE lower(i.email) = k.assignee LIMIT 1) e ON true WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params)).rows;
  return { kapsam: onlyOpen ? 'açık biletler' : 'tüm biletler', toplam: t.toplam_acik, gruplama: groupBy, satirlar: rows.map((r) => ({ ad: r.g, adet: r.n })) };
}

export interface WorkloadFilter { person?: string | null; project?: string | null }

/** For each person in scope: their open tickets, open Planner tasks and open project-plan tasks. */
export async function teamWorkload(db: Db, user: User, f: WorkloadFilter = {}) {
  const scope = await visiblePeople(db, user);
  let ppl = (await db.query<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM employees WHERE active ${scope ? 'AND id = ANY($1::uuid[])' : ''} ORDER BY name`, scope ? [scope] : [])).rows;
  if (f.person) { const q = fold(f.person); ppl = ppl.filter((p) => fold(`${p.name} ${p.email}`).includes(q)); }
  if (f.project) {
    const q = fold(f.project);
    const proj = (await db.query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE active')).rows.filter((p) => fold(p.name).includes(q));
    if (!proj.length) return { hata: `“${f.project}” adında bir proje bulunamadı.` };
    const members = new Set((await db.query<{ employee_id: string }>('SELECT employee_id FROM employee_projects WHERE project_id = ANY($1::uuid[])', [proj.map((p) => p.id)])).rows.map((m) => m.employee_id));
    ppl = ppl.filter((p) => members.has(p.id));
  }
  if (!ppl.length) return { hata: 'Bu kriterlere uyan, görüntüleme yetkiniz olan kişi bulunamadı.' };

  const out = [];
  for (const p of ppl) {
    const tickets = (await db.query<TicketRow>(`${TICKETS_SQL} WHERE e.id = $2 AND k.closed_at IS NULL AND coalesce(k.status, '') !~* $1 ORDER BY k.opened_at ASC NULLS LAST`, [CLOSED_STATUS, p.id])).rows;
    const planner = (await db.query<{ title: string; due_date: string | null; percent_complete: number; project: string }>(
      `SELECT t.title, t.due_date, t.percent_complete, pr.name AS project
         FROM planner_tasks t JOIN project_plans pp ON pp.tenant_id = t.tenant_id AND pp.plan_id = t.plan_id JOIN projects pr ON pr.id = pp.project_id AND pr.active
        WHERE t.percent_complete < 100 AND EXISTS (SELECT 1 FROM identities i WHERE i.employee_id = $1 AND i.tenant_id = t.tenant_id AND i.entra_oid = ANY (t.assignee_oids))
        ORDER BY t.due_date NULLS LAST`, [p.id])).rows;
    const plan = (await db.query<{ ext_id: string; title: string; due_date: string | null; status: string; project: string }>(
      `SELECT t.ext_id, t.title, t.due_date, t.status, pr.name AS project FROM project_tasks t JOIN projects pr ON pr.id = t.project_id AND pr.active
        WHERE t.owner_id = $1 AND t.status <> 'Tamamlandı' ORDER BY t.due_date NULLS LAST`, [p.id])).rows;
    out.push({
      kisi: p.name,
      acik_bilet_sayisi: tickets.length,
      biletler: tickets.slice(0, 8).map((k) => ({ no: k.id, konu: k.title, musteri: k.customer, durum: k.status, yas_gun: k.age_days })),
      planner_gorev_sayisi: planner.length,
      planner_gorevleri: planner.slice(0, 8).map((t) => ({ gorev: t.title, proje: t.project, bitis: t.due_date, yuzde: t.percent_complete })),
      proje_plani_gorev_sayisi: plan.length,
      proje_plani_gorevleri: plan.slice(0, 8).map((t) => ({ id: t.ext_id, gorev: t.title, proje: t.project, bitis: t.due_date, durum: t.status })),
    });
  }
  return { kisi_sayisi: out.length, kisiler: out };
}

/** True when the ticket is assigned to someone the person may ask about (admins: any ticket, assigned or not). */
export async function ticketVisible(db: Db, user: User, no: string): Promise<boolean> {
  const scope = await visiblePeople(db, user);
  const params: unknown[] = [no];
  let where = 'k.id = $1';
  if (scope) { params.push(scope); where += people(scope, params.length); }
  return (await db.query(`${TICKETS_SQL} WHERE ${where} LIMIT 1`, params)).rows.length > 0;
}
