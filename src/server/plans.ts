import { preRead } from '../core/grid.js';
import { describeChange, normalizeStatus, parsePlanSheet, validateEdits, type PlanChange, type PlanTask } from '../core/plan.js';
import { fold } from '../core/turkish.js';
import { audit } from './access.js';
import type { PlanTaskView } from './ai.js';
import type { Ctx } from './context.js';
import type { Db } from './db.js';
import { EntryError } from './entries.js';
import { atLeast, type User } from './session.js';

export interface PlanRow {
  id: string; ext_id: string; section: string | null; title: string; owner_name: string | null; owner_id: string | null;
  depends_on: string | null; due_date: string | null; status: string; position: number;
}

/** Only a PM who owns the project, or an admin, may change its plan. */
export async function assertCanEditPlan(db: Db, user: User, projectId: string): Promise<void> {
  if (!atLeast(user, 'PM')) throw new EntryError('Bu işlem için yetkiniz yok', 403);
  if (user.role === 'Admin') {
    const ok = await db.query('SELECT 1 FROM projects WHERE id=$1', [projectId]);
    if (!ok.rows.length) throw new EntryError('Proje bulunamadı', 404);
    return;
  }
  const ok = await db.query('SELECT 1 FROM projects WHERE id=$1 AND created_by=$2', [projectId, user.employeeId]);
  if (!ok.rows.length) throw new EntryError('Bu proje size ait değil', 403);
}

export async function listPlan(db: Db, projectId: string): Promise<PlanRow[]> {
  return (await db.query<PlanRow>(
    `SELECT id, ext_id, section, title, owner_name, owner_id, depends_on, due_date, status, position
       FROM project_tasks WHERE project_id=$1 ORDER BY position, ext_id`, [projectId])).rows;
}

const toTask = (r: PlanRow): PlanTask => ({
  extId: r.ext_id, section: r.section, title: r.title, owner: r.owner_name, dependsOn: r.depends_on, dueDate: r.due_date, status: r.status as PlanTask['status'],
});
const toView = (t: PlanTask): PlanTaskView => ({ ext_id: t.extId, section: t.section, title: t.title, owner: t.owner, depends_on: t.dependsOn, due_date: t.dueDate, status: t.status });

/** "Mesut" → the one active employee whose first name is Mesut; ambiguous or unknown stays unlinked. */
async function matchOwner(db: Db, owner: string | null): Promise<string | null> {
  if (!owner) return null;
  const o = fold(owner);
  const people = (await db.query<{ id: string; name: string }>('SELECT id, name FROM employees WHERE active')).rows;
  const hits = people.filter((p) => fold(p.name) === o || fold(p.name).split(' ')[0] === o);
  return hits.length === 1 ? hits[0].id : null;
}

export interface PlanProposal {
  actionId: string | null;
  /** What applying it would do, one line per change. */
  lines: string[];
  rejected: string[];
  notes: string[];
}

async function stage(db: Db, user: User, kind: 'plan_import' | 'plan_update', payload: unknown): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO pending_actions (employee_id, kind, payload) VALUES ($1,$2,$3) RETURNING id`, [user.employeeId, kind, JSON.stringify(payload)])).rows[0].id;
}

/**
 * Read an Excel/CSV plan and stage it as a pending import. The fixed parser goes first;
 * the model is only asked when the parser finds nothing. Nothing is saved until the person applies it.
 */
export async function stagePlanImport(ctx: Ctx, user: User, projectId: string, fileName: string, buf: Buffer): Promise<PlanProposal & { tasks: PlanTask[] }> {
  await assertCanEditPlan(ctx.db, user, projectId);
  const pre = await preRead(fileName, buf);
  const year = Number(ctx.today().slice(0, 4));
  let { tasks, notes } = parsePlanSheet(pre, year);
  let viaAi = false;
  if (!tasks.length && ctx.ai.model !== 'unconfigured') {
    const ex = await ctx.ai.extractPlan({ fileName, compact: pre.compact });
    const check = validateEdits([], [], ex.tasks.map((t) => ({ ...t, status: t.status })), year);
    tasks = check.changes.flatMap((c) => (c.task ? [{ ...c.task, section: ex.tasks.find((x) => x.ext_id === c.extId)?.section ?? null }] : []));
    notes = [...ex.notes, ...check.rejected];
    viaAi = true;
  }
  const current = await listPlan(ctx.db, projectId);
  const have = new Set(current.map((t) => t.ext_id.toLowerCase()));
  const lines = tasks.map((t) => `${have.has(t.extId.toLowerCase()) ? 'Güncelle' : 'Ekle'} ${t.extId}: ${t.title}${t.dueDate ? ` · ${t.dueDate}` : ''} · ${t.status}`);
  if (viaAi && tasks.length) notes.push('Dosya yapay zekâ ile okundu; lütfen satırları kontrol edin.');
  if (!tasks.length) notes.unshift('Dosyada proje planı satırı (W1.1 gibi kimlik, görev ve tarih) bulunamadı.');
  if (!tasks.length) return { actionId: null, lines, rejected: [], notes, tasks };
  const actionId = await stage(ctx.db, user, 'plan_import', { projectId, tasks, fileName });
  return { actionId, lines, rejected: [], notes, tasks };
}

/**
 * Stage the project's linked Planner tasks as project-plan rows (bucket → section, assignee → owner,
 * percent → status). Re-running updates the same rows because the id is derived from the Planner task id.
 */
export async function stagePlannerImport(ctx: Ctx, user: User, projectId: string): Promise<PlanProposal & { tasks: PlanTask[] }> {
  await assertCanEditPlan(ctx.db, user, projectId);
  const linked = (await ctx.db.query('SELECT 1 FROM project_plans WHERE project_id=$1', [projectId])).rows.length;
  const rows = (await ctx.db.query<{ id: string; title: string; bucket: string | null; due_date: string | null; percent_complete: number; owner: string | null }>(
    `SELECT t.id, t.title, t.bucket, t.due_date, t.percent_complete,
            (SELECT e.name FROM identities i JOIN employees e ON e.id = i.employee_id
              WHERE i.tenant_id = t.tenant_id AND i.entra_oid = ANY (t.assignee_oids) ORDER BY e.name LIMIT 1) AS owner
       FROM planner_tasks t JOIN project_plans pp ON pp.tenant_id = t.tenant_id AND pp.plan_id = t.plan_id
      WHERE pp.project_id = $1 ORDER BY t.bucket NULLS LAST, t.title`, [projectId])).rows;
  const tasks: PlanTask[] = rows.map((r) => ({
    extId: `PL-${r.id.slice(0, 8)}`, section: r.bucket, title: r.title, owner: r.owner, dependsOn: null, dueDate: r.due_date,
    status: r.percent_complete >= 100 ? 'Tamamlandı' : r.percent_complete > 0 ? 'Devam' : 'Planlandı',
  }));
  const notes: string[] = [];
  if (!linked) notes.push('Bu projeye henüz bir Planner planı bağlı değil. Önce “Planner planı bağla” ile bir plan seçin.');
  else if (!tasks.length) notes.push('Bağlı planda henüz görev yok. Planner eşitlemesi tamamlandıktan sonra tekrar deneyin.');
  if (!tasks.length) return { actionId: null, lines: [], rejected: [], notes, tasks };
  const have = new Set((await listPlan(ctx.db, projectId)).map((t) => t.ext_id.toLowerCase()));
  const lines = tasks.map((t) => `${have.has(t.extId.toLowerCase()) ? 'Güncelle' : 'Ekle'} ${t.title}${t.dueDate ? ` · ${t.dueDate}` : ''} · ${t.status}`);
  const actionId = await stage(ctx.db, user, 'plan_import', { projectId, tasks, fileName: 'Planner' });
  return { actionId, lines, rejected: [], notes, tasks };
}

export async function applyPlanImport(db: Db, user: User, payload: { projectId: string; tasks: PlanTask[]; fileName?: string }): Promise<string> {
  await assertCanEditPlan(db, user, payload.projectId);
  await db.tx(async (t) => {
    const pos = (await t.query<{ n: number }>('SELECT coalesce(max(position), 0)::int AS n FROM project_tasks WHERE project_id=$1', [payload.projectId])).rows[0].n;
    let i = pos;
    for (const task of payload.tasks) {
      const ownerId = await matchOwner(t, task.owner);
      i++;
      await t.query(
        `INSERT INTO project_tasks (project_id, ext_id, section, title, owner_name, owner_id, depends_on, due_date, status, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (project_id, ext_id) DO UPDATE SET section=EXCLUDED.section, title=EXCLUDED.title, owner_name=EXCLUDED.owner_name,
           owner_id=EXCLUDED.owner_id, depends_on=EXCLUDED.depends_on, due_date=EXCLUDED.due_date, status=EXCLUDED.status, updated_at=now()`,
        [payload.projectId, task.extId, task.section, task.title, task.owner, ownerId, task.dependsOn, task.dueDate, task.status, i]);
    }
    await audit(t, user.employeeId, 'plan_import', payload.projectId, { tasks: payload.tasks.length, file: payload.fileName });
  });
  return `${payload.tasks.length} görev projeye işlendi.`;
}

/** The assistant proposes; code validates every edit against the real plan; a click applies it. */
export async function proposePlanEdit(ctx: Ctx, user: User, projectId: string, instruction: string): Promise<PlanProposal> {
  await assertCanEditPlan(ctx.db, user, projectId);
  const text = instruction.trim().slice(0, 2000);
  if (!text) throw new EntryError('Bir talimat yazın');
  const current = (await listPlan(ctx.db, projectId)).map(toTask);
  const prop = await ctx.ai.editPlan({ instruction: text, today: ctx.today(), tasks: current.map(toView) });
  const { changes, rejected } = validateEdits(current, prop.edits, prop.added, Number(ctx.today().slice(0, 4)));
  const lines = changes.map(describeChange);
  if (!changes.length) return { actionId: null, lines, rejected, notes: prop.notes };
  const actionId = await stage(ctx.db, user, 'plan_update', { projectId, changes, instruction: text });
  return { actionId, lines, rejected, notes: prop.notes };
}

const COLUMN: Record<string, string> = { status: 'status', due_date: 'due_date', owner: 'owner_name', title: 'title', depends_on: 'depends_on' };

export async function applyPlanUpdate(db: Db, user: User, payload: { projectId: string; changes: PlanChange[] }): Promise<string> {
  await assertCanEditPlan(db, user, payload.projectId);
  let n = 0;
  await db.tx(async (t) => {
    for (const c of payload.changes) {
      if (c.kind === 'add' && c.task) {
        const ownerId = await matchOwner(t, c.task.owner);
        const pos = (await t.query<{ n: number }>('SELECT coalesce(max(position), 0)::int + 1 AS n FROM project_tasks WHERE project_id=$1', [payload.projectId])).rows[0].n;
        const r = await t.query(
          `INSERT INTO project_tasks (project_id, ext_id, section, title, owner_name, owner_id, depends_on, due_date, status, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (project_id, ext_id) DO NOTHING RETURNING id`,
          [payload.projectId, c.task.extId, c.task.section, c.task.title, c.task.owner, ownerId, c.task.dependsOn, c.task.dueDate, c.task.status, pos]);
        n += r.rows.length;
      } else if (c.kind === 'update' && c.field && COLUMN[c.field]) {
        const col = COLUMN[c.field]; // fixed whitelist, never from the request
        const value = c.field === 'status' ? normalizeStatus(c.to) : c.to;
        if (c.field === 'status' && !value) continue;
        const r = await t.query(`UPDATE project_tasks SET ${col}=$3, updated_at=now() WHERE project_id=$1 AND lower(ext_id)=lower($2) RETURNING id`, [payload.projectId, c.extId, value]);
        if (c.field === 'owner' && r.rows.length) await t.query('UPDATE project_tasks SET owner_id=$3 WHERE project_id=$1 AND lower(ext_id)=lower($2)', [payload.projectId, c.extId, await matchOwner(t, c.to ?? null)]);
        n += r.rows.length;
      }
    }
    await audit(t, user.employeeId, 'plan_update', payload.projectId, { changes: payload.changes.length });
  });
  return `${n} değişiklik uygulandı.`;
}

/** Direct edit from the plan table: a status or date change by a PM needs no assistant. */
export async function patchPlanTask(db: Db, user: User, projectId: string, taskId: string, input: { status?: string; due_date?: string | null; owner?: string | null }): Promise<void> {
  await assertCanEditPlan(db, user, projectId);
  const cur = (await db.query<PlanRow>('SELECT * FROM project_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId])).rows[0];
  if (!cur) throw new EntryError('Görev bulunamadı', 404);
  const sets: string[] = []; const params: unknown[] = [taskId];
  if (input.status !== undefined) {
    const s = normalizeStatus(input.status);
    if (!s) throw new EntryError('Geçersiz durum');
    params.push(s); sets.push(`status=$${params.length}`);
  }
  if (input.due_date !== undefined) {
    if (input.due_date !== null && !/^\d{4}-\d\d-\d\d$/.test(input.due_date)) throw new EntryError('Tarih YYYY-AA-GG olmalı');
    params.push(input.due_date); sets.push(`due_date=$${params.length}`);
  }
  if (input.owner !== undefined) {
    params.push(input.owner); sets.push(`owner_name=$${params.length}`);
    params.push(await matchOwner(db, input.owner)); sets.push(`owner_id=$${params.length}`);
  }
  if (!sets.length) return;
  await db.query(`UPDATE project_tasks SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, params);
  await audit(db, user.employeeId, 'plan_task_edit', taskId, { before: { status: cur.status, due: cur.due_date, owner: cur.owner_name }, input });
}

/** Entries pointing at a removed task must not keep a dangling link. */
async function clearLinks(db: Db, kind: 'planner' | 'project', ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.query(`UPDATE entries SET link_kind=NULL, link_id=NULL, link_tenant=NULL, link_via=NULL, link_score=NULL WHERE link_kind=$1 AND link_id = ANY($2::text[])`, [kind, ids]);
}

export async function deletePlanTask(db: Db, user: User, projectId: string, taskId: string): Promise<void> {
  await assertCanEditPlan(db, user, projectId);
  await db.tx(async (t) => {
    const r = await t.query(`DELETE FROM project_tasks WHERE id=$1 AND project_id=$2 RETURNING id::text AS id`, [taskId, projectId]);
    if (!r.rows.length) throw new EntryError('Görev bulunamadı', 404);
    await clearLinks(t, 'project', [taskId]);
    await audit(t, user.employeeId, 'plan_task_delete', taskId);
  });
}

/** Delete the project's whole plan (all tasks). The project, its team and logged effort stay. */
export async function deleteWholePlan(db: Db, user: User, projectId: string): Promise<number> {
  await assertCanEditPlan(db, user, projectId);
  return db.tx(async (t) => {
    const r = await t.query<{ id: string }>(`DELETE FROM project_tasks WHERE project_id=$1 RETURNING id::text AS id`, [projectId]);
    await clearLinks(t, 'project', r.rows.map((x) => x.id));
    await audit(t, user.employeeId, 'plan_delete', projectId, { tasks: r.rows.length });
    return r.rows.length;
  });
}

/** Stop syncing a Planner plan for this project and drop its cached tasks (Planner itself is untouched). */
export async function unlinkPlannerPlan(db: Db, user: User, projectId: string, tenantId: string, planId: string): Promise<number> {
  await assertCanEditPlan(db, user, projectId);
  return db.tx(async (t) => {
    const l = await t.query(`DELETE FROM project_plans WHERE project_id=$1 AND tenant_id=$2 AND plan_id=$3 RETURNING plan_id`, [projectId, tenantId, planId]);
    if (!l.rows.length) throw new EntryError('Plan bağlantısı bulunamadı', 404);
    const stillUsed = await t.query(`SELECT 1 FROM project_plans WHERE tenant_id=$1 AND plan_id=$2`, [tenantId, planId]);
    let n = 0;
    if (!stillUsed.rows.length) {
      const gone = await t.query<{ id: string }>(`DELETE FROM planner_tasks WHERE tenant_id=$1 AND plan_id=$2 RETURNING id`, [tenantId, planId]);
      await clearLinks(t, 'planner', gone.rows.map((x) => x.id));
      n = gone.rows.length;
    }
    await audit(t, user.employeeId, 'planner_unlink', projectId, { planId, tasks: n });
    return n;
  });
}

/** "Delete" a project: it disappears from every list and stops syncing; logged effort and reports keep its name. */
export async function archiveProject(db: Db, user: User, projectId: string): Promise<void> {
  await assertCanEditPlan(db, user, projectId);
  await db.query(`UPDATE projects SET active=false WHERE id=$1`, [projectId]);
  await audit(db, user.employeeId, 'project_delete', projectId);
}
