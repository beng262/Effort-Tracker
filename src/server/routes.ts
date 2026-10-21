import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { z } from 'zod';
import { preRead } from '../core/grid.js';
import { mondayOf } from '../core/turkish.js';
import { audit } from './access.js';
import { applyPending, AssistantUnavailable, cancelPending, chatFile, chatTurn, draftCard } from './chat.js';
import type { Ctx } from './context.js';
import type { Db } from './db.js';
import { confirmEntries, createEntry, deleteEntries, deleteEntry, deleteUpload, restoreEntry, EntryError, updateEntry, weekView, type EntryRow } from './entries.js';
import { reportToPdf, reportToXlsx } from './export.js';
import { discoverPlans, syncAll, syncTenant, type Graph } from './graph.js';
import { parsePlanSheet } from '../core/plan.js';
import { config } from './config.js';
import { openTickets, ticketVisible } from './workload.js';
import { recomputeDate, workWindow } from './overtime.js';
import { currentItsmKey, forgetItsmKey, loadItsm, runItsmSync } from './itsm.js';
import { addCustomer, listCustomers } from './customers.js';
import { archiveProject, deletePlanTask, deleteWholePlan, listPlan, patchPlanTask, unlinkPlannerPlan, proposePlanEdit, stagePlanImport, stagePlannerImport } from './plans.js';
import { candidatesFor, confirmUpload, DuplicateUploadError, UnreadableFileError, NotConfirmable, processUpload } from './pipeline.js';
import { definitionSchema, presetsFor, PRESETS, runReport } from './reports.js';
import { atLeast, requireRole, requireUser, type User } from './session.js';

const ALLOWED = /\.(xlsx|xlsm|csv|txt|md)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED.test(file.originalname)),
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res).catch(next);
};

const uuid = z.string().uuid();

export function apiRouter(ctx: Ctx, graph: Graph): Router {
  const r = Router();
  const { db } = ctx;
  r.use('/api', requireUser);
  const me = (req: Request) => req.user as User;
  const today = () => ctx.today();

  /* ---------- week / entries ---------- */

  r.get('/api/week', wrap(async (req, res) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(req.query.date) ? req.query.date : today();
    res.json(await weekView(db, me(req).employeeId, date, today()));
  }));

  r.get('/api/entries', wrap(async (req, res) => {
    const from = String(req.query.from ?? mondayOf(today()));
    const to = String(req.query.to ?? today());
    const rows = (await db.query<EntryRow>(`SELECT * FROM entries WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 AND NOT deleted ORDER BY work_date, created_at`, [me(req).employeeId, from, to])).rows;
    res.json(rows);
  }));

  const entryBody = z.object({
    date: z.string().nullable().optional(), start: z.string().nullable().optional(), end: z.string().nullable().optional(),
    hours: z.union([z.number(), z.string()]).nullable().optional(), description: z.string().max(1000).optional(),
    projectId: uuid.nullable().optional(),
    category: z.string().max(60).nullable().optional(), customer: z.string().max(300).nullable().optional(), workItem: z.string().max(300).nullable().optional(),
    product: z.string().max(300).nullable().optional(), outcome: z.string().max(300).nullable().optional(), progress: z.string().max(60).nullable().optional(),
    link: z.object({ kind: z.enum(['planner', 'itsm', 'project']), id: z.string(), tenantId: z.string().optional() }).nullable().optional(),
  });

  r.post('/api/entries', wrap(async (req, res) => {
    const u = me(req);
    const e = await createEntry(ctx, u.employeeId, u.dayHours, entryBody.parse(req.body));
    const saved = await confirmEntries(db, u.employeeId, [e.id]);
    res.status(201).json({ ...(await db.query<EntryRow>('SELECT * FROM entries WHERE id=$1', [e.id])).rows[0], saved: saved === 1 });
  }));

  r.patch('/api/entries/:id', wrap(async (req, res) => {
    const u = me(req);
    res.json(await updateEntry(ctx, u.employeeId, uuid.parse(req.params.id), entryBody.parse(req.body), u.dayHours));
  }));

  r.delete('/api/entries/:id', wrap(async (req, res) => {
    await deleteEntry(ctx, me(req).employeeId, uuid.parse(req.params.id));
    res.json({ ok: true });
  }));

  /** Delete several rows at once (the week table's selection); anything that cannot be deleted is counted. */
  r.post('/api/entries/delete', wrap(async (req, res) => {
    const { ids } = z.object({ ids: z.array(uuid).min(1).max(500) }).parse(req.body);
    res.json(await deleteEntries(ctx, me(req).employeeId, ids));
  }));

  /** Undo a delete shortly after it. */
  r.post('/api/entries/:id/restore', wrap(async (req, res) => {
    res.json(await restoreEntry(ctx, me(req).employeeId, uuid.parse(req.params.id)));
  }));

  /** Candidate tasks and tickets for the "pick a task" step of an unlinked row. */
  r.get('/api/entries/:id/options', wrap(async (req, res) => {
    const u = me(req);
    const e = (await db.query<EntryRow>('SELECT * FROM entries WHERE id=$1 AND employee_id=$2 AND NOT deleted', [uuid.parse(req.params.id), u.employeeId])).rows[0];
    if (!e) throw new EntryError('Kayıt bulunamadı', 404);
    const projectIds = e.project_id ? [e.project_id] : (await db.query<{ project_id: string }>('SELECT project_id FROM employee_projects WHERE employee_id=$1', [u.employeeId])).rows.map((x) => x.project_id);
    const all = await candidatesFor(db, u.employeeId, projectIds);
    res.json(all.map(({ kind, id, title, extra, tenantId }) => ({ kind, id, title, extra, tenantId })));
  }));

  /* ---------- the standard form ---------- */

  /** The Excel form people fill in. The same file the upload page reads by fixed rules. */
  r.get('/api/template', (_req, res, next) => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'Gunluk_Efor_Giris_Sablonu.xlsx');
    res.download(file, 'Gunluk_Efor_Giris_Sablonu.xlsx', (err) => { if (err && !res.headersSent) next(err); });
  });

  /* ---------- uploads ---------- */

  r.post('/api/uploads', upload.single('file'), wrap(async (req, res) => {
    const u = me(req);
    if (!req.file) throw new EntryError('Desteklenen dosya türleri: .xlsx, .csv, .txt');
    const projectId = typeof req.body.projectId === 'string' && req.body.projectId ? uuid.parse(req.body.projectId) : null;
    if (projectId) await assertAssigned(u, projectId);
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
      res.status(201).json(await processUpload(ctx, { employeeId: u.employeeId, dayHours: u.dayHours, projectId, channel: 'page', fileName: name.match(ALLOWED) ? name : req.file.originalname, buf: req.file.buffer }));
    } catch (e) {
      if (e instanceof DuplicateUploadError) return void res.status(409).json({ error: e.message, uploadId: e.existingId });
      throw e;
    }
  }));

  async function assertAssigned(u: User, projectId: string) {
    if (atLeast(u, 'PM')) return;
    const ok = await db.query('SELECT 1 FROM employee_projects WHERE employee_id=$1 AND project_id=$2', [u.employeeId, projectId]);
    if (!ok.rows.length) throw new EntryError('Bu proje size atanmamış', 403);
  }

  r.get('/api/uploads', wrap(async (req, res) => {
    res.json((await db.query(`SELECT id, file_name, channel, status, path_taken, created_at, week_start,
        (SELECT count(*)::int FROM entries e WHERE e.upload_id = uploads.id AND NOT e.deleted) AS rows
        FROM uploads WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 50`, [me(req).employeeId])).rows);
  }));

  r.get('/api/uploads/:id', wrap(async (req, res) => {
    const u = me(req);
    const id = uuid.parse(req.params.id);
    const up = (await db.query(`SELECT id, file_name, channel, status, path_taken, model, prompt_version, notes, error, week_start, created_at FROM uploads WHERE id=$1 AND employee_id=$2`, [id, u.employeeId])).rows[0];
    if (!up) throw new EntryError('Yükleme bulunamadı', 404);
    const card = await draftCard(ctx, u.employeeId, id);
    const rows = (await db.query<EntryRow>(`SELECT * FROM entries WHERE upload_id=$1 AND NOT deleted ORDER BY work_date NULLS FIRST, created_at`, [id])).rows;
    // A file with no effort in it may be a project plan: tell the screen so it can offer to send it to a project.
    let planTasks = 0;
    if (!rows.length) {
      const f = (await db.query<{ blob_path: string | null; file_name: string }>('SELECT blob_path, file_name FROM uploads WHERE id=$1', [id])).rows[0];
      if (f?.blob_path) {
        try { planTasks = parsePlanSheet(await preRead(f.file_name, await ctx.blob.get(f.blob_path)), Number(today().slice(0, 4))).tasks.length; } catch { /* not readable as a plan: no offer */ }
      }
    }
    res.json({ upload: up, rows, blocked: card.blocked, total: card.total, plan_tasks: planTasks });
  }));

  /** The original beside the rows: the review screen highlights the cell or line a row came from. */
  r.get('/api/uploads/:id/source', wrap(async (req, res) => {
    const u = me(req);
    const up = (await db.query<{ blob_path: string | null; file_name: string }>('SELECT blob_path, file_name FROM uploads WHERE id=$1 AND employee_id=$2', [uuid.parse(req.params.id), u.employeeId])).rows[0];
    if (!up?.blob_path) throw new EntryError('Dosya bulunamadı', 404);
    const pre = await preRead(up.file_name, await ctx.blob.get(up.blob_path));
    res.json({ kind: pre.kind, sheets: pre.sheets.map((s) => ({ name: s.name, rows: s.rows.slice(0, 500) })) });
  }));

  /** An uploaded file that is really a project plan: stage it for a project; the PM applies it with a click. */
  r.post('/api/uploads/:id/as-plan', requireRole('PM'), wrap(async (req, res) => {
    const u = me(req);
    const { projectId } = z.object({ projectId: uuid }).parse(req.body);
    const up = (await db.query<{ blob_path: string | null; file_name: string }>('SELECT blob_path, file_name FROM uploads WHERE id=$1 AND employee_id=$2', [uuid.parse(req.params.id), u.employeeId])).rows[0];
    if (!up?.blob_path) throw new EntryError('Dosya bulunamadı', 404);
    res.json(await stagePlanImport(ctx, u, projectId, up.file_name, await ctx.blob.get(up.blob_path)));
  }));

  r.post('/api/uploads/:id/confirm', wrap(async (req, res) => {
    try { res.json(await confirmUpload(db, me(req).employeeId, uuid.parse(req.params.id))); }
    catch (e) { if (e instanceof NotConfirmable) return void res.status(409).json({ error: e.message }); throw e; }
  }));

  /** Remove a file from the history together with every row it produced. */
  r.delete('/api/uploads/:id', wrap(async (req, res) => {
    res.json(await deleteUpload(ctx, me(req).employeeId, uuid.parse(req.params.id)));
  }));

  r.post('/api/uploads/:id/discard', wrap(async (req, res) => {
    const u = me(req);
    const id = uuid.parse(req.params.id);
    const ok = await db.query(`UPDATE uploads SET status='discarded' WHERE id=$1 AND employee_id=$2 AND status='review' RETURNING id`, [id, u.employeeId]);
    if (!ok.rows.length) throw new EntryError('Yükleme bulunamadı veya zaten işlenmiş', 404);
    await db.query(`UPDATE entries SET deleted=true WHERE upload_id=$1 AND status='draft'`, [id]);
    await audit(db, u.employeeId, 'discard_upload', id);
    res.json({ ok: true });
  }));

  /* ---------- working hours and holidays ---------- */

  r.get('/api/settings', wrap(async (_req, res) => { res.json({ workStart: workWindow().start, workEnd: workWindow().end }); }));

  r.get('/api/holidays', wrap(async (req, res) => {
    const year = z.coerce.number().int().min(2020).max(2100).default(Number(today().slice(0, 4))).parse(req.query.year);
    res.json((await db.query<{ date: string; name: string }>('SELECT date, name FROM holidays WHERE date BETWEEN $1 AND $2 ORDER BY date', [`${year}-01-01`, `${year}-12-31`])).rows);
  }));

  /** Every hour on a holiday is overtime, so adding or removing one recalculates everyone's entries on that date. */
  r.post('/api/holidays', requireRole('Admin'), wrap(async (req, res) => {
    const b = z.object({ date: z.string().regex(/^\d{4}-\d\d-\d\d$/), name: z.string().trim().min(1).max(100) }).parse(req.body);
    await db.query('INSERT INTO holidays (date, name) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET name=EXCLUDED.name', [b.date, b.name]);
    await recomputeDate(db, b.date);
    await audit(db, me(req).employeeId, 'holiday_set', b.date, { name: b.name });
    res.json({ ok: true });
  }));

  r.delete('/api/holidays/:date', requireRole('Admin'), wrap(async (req, res) => {
    const date = z.string().regex(/^\d{4}-\d\d-\d\d$/).parse(req.params.date);
    await db.query('DELETE FROM holidays WHERE date=$1', [date]);
    await recomputeDate(db, date);
    await audit(db, me(req).employeeId, 'holiday_delete', date);
    res.json({ ok: true });
  }));

  /* ---------- projects, people ---------- */

  r.get('/api/projects', wrap(async (req, res) => {
    const u = me(req);
    const rows = atLeast(u, 'PM')
      ? (await db.query(`SELECT p.*, (SELECT json_agg(json_build_object('tenantId', pp.tenant_id, 'planId', pp.plan_id, 'title', pp.plan_title)) FROM project_plans pp WHERE pp.project_id = p.id) AS plans,
            (SELECT coalesce(json_agg(ep.employee_id), '[]') FROM employee_projects ep WHERE ep.project_id = p.id) AS members,
            (SELECT count(*)::int FROM project_tasks x WHERE x.project_id = p.id) AS plan_count,
            (SELECT count(*)::int FROM planner_tasks t JOIN project_plans pp ON pp.tenant_id = t.tenant_id AND pp.plan_id = t.plan_id WHERE pp.project_id = p.id) AS task_count,
            (SELECT max(t.synced_at) FROM planner_tasks t JOIN project_plans pp ON pp.tenant_id = t.tenant_id AND pp.plan_id = t.plan_id WHERE pp.project_id = p.id) AS synced_at
          FROM projects p WHERE p.active ORDER BY p.name`)).rows
      : (await db.query(`SELECT p.id, p.name, p.code, p.customer FROM projects p JOIN employee_projects ep ON ep.project_id = p.id WHERE ep.employee_id=$1 AND p.active ORDER BY p.name`, [u.employeeId])).rows;
    res.json(rows);
  }));

  /* ---------- customers: ITSM ones plus those added by hand ---------- */

  r.get('/api/customers', wrap(async (_req, res) => { res.json(await listCustomers(db)); }));

  r.post('/api/customers', wrap(async (req, res) => {
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    res.status(201).json(await addCustomer(db, me(req).employeeId, name));
  }));

  /** Anyone can add a project while entering effort; they join its team, so it shows up in their lists. */
  r.post('/api/projects/quick', wrap(async (req, res) => {
    const u = me(req);
    const b = z.object({ name: z.string().min(1).max(200), customer: z.string().max(200).nullable().optional() }).parse(req.body);
    const name = b.name.trim();
    const dup = (await db.query<{ id: string }>(`SELECT id FROM projects WHERE active AND lower(name)=lower($1)`, [name])).rows[0];
    if (dup) throw new EntryError(`“${name}” adında bir proje zaten var; listeden seçebilirsiniz.`, 409);
    const customer = b.customer?.trim() ? (await addCustomer(db, u.employeeId, b.customer)).name : null;
    const id = await db.tx(async (t) => {
      const pid = (await t.query<{ id: string }>(`INSERT INTO projects (name, customer, created_by) VALUES ($1,$2,$3) RETURNING id`, [name, customer, u.employeeId])).rows[0].id;
      await t.query('INSERT INTO employee_projects VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.employeeId, pid]);
      await audit(t, u.employeeId, 'project_create', pid, { name, quick: true });
      return pid;
    });
    res.status(201).json({ id, name, customer });
  }));

  /**
   * A Planner plan can belong to one project only. A plan held by a deleted project is free again;
   * one held by a live project is refused with that project's name (never silently moved).
   */
  async function claimPlan(t: Db, projectId: string | null, tenantId: string, planId: string): Promise<void> {
    const held = (await t.query<{ project_id: string; name: string; active: boolean }>(
      `SELECT pp.project_id, p.name, p.active FROM project_plans pp JOIN projects p ON p.id = pp.project_id WHERE pp.tenant_id=$1 AND pp.plan_id=$2`, [tenantId, planId])).rows[0];
    if (!held || held.project_id === projectId) return;
    if (held.active) throw new EntryError(`Bu Planner planı zaten “${held.name}” projesine bağlı. Bir plan yalnızca tek projeye bağlanabilir; önce o projeden bağlantıyı kaldırın.`, 409);
    await t.query('DELETE FROM project_plans WHERE tenant_id=$1 AND plan_id=$2', [tenantId, planId]);
  }

  const projectBody = z.object({
    name: z.string().min(1).max(200).optional(), code: z.string().max(50).nullable().optional(), customer: z.string().max(200).nullable().optional(),
    tenantId: z.string().max(100).nullable().optional(),
    plans: z.array(z.object({ tenantId: z.string(), planId: z.string(), title: z.string().nullable().optional() })).optional(),
  });

  r.post('/api/projects', requireRole('PM'), wrap(async (req, res) => {
    const u = me(req);
    const b = projectBody.parse(req.body);
    const name = b.name ?? b.plans?.[0]?.title;
    if (!name) throw new EntryError('Proje adı gerekli');
    if (b.customer?.trim()) b.customer = (await addCustomer(db, u.employeeId, b.customer)).name;
    const id = await db.tx(async (t) => {
      const pid = (await t.query<{ id: string }>(`INSERT INTO projects (name, code, customer, tenant_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name, b.code ?? null, b.customer ?? null, b.tenantId ?? b.plans?.[0]?.tenantId ?? null, u.employeeId])).rows[0].id;
      for (const p of b.plans ?? []) {
        await claimPlan(t, pid, p.tenantId, p.planId);
        await t.query(`INSERT INTO project_plans (project_id, tenant_id, plan_id, plan_title) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, plan_id) DO NOTHING`, [pid, p.tenantId, p.planId, p.title ?? null]);
      }
      await audit(t, u.employeeId, 'project_create', pid, { name });
      return pid;
    });
    // A project created from a plan pulls its tasks straight away; the periodic sync keeps them current.
    for (const tid of new Set((b.plans ?? []).map((p) => p.tenantId))) void syncTenant(db, graph, tid).catch((e) => console.error('planner sync after project create failed', e));
    res.status(201).json({ id });
  }));

  r.patch('/api/projects/:id', requireRole('PM'), wrap(async (req, res) => {
    const u = me(req);
    const b = projectBody.omit({ plans: true }).extend({ active: z.boolean().optional() }).parse(req.body);
    const id = uuid.parse(req.params.id);
    if (!(await db.query('SELECT 1 FROM projects WHERE id=$1', [id])).rows.length) throw new EntryError('Proje bulunamadı', 404);
    await assertOwnsProject(u, id);
    const sets: string[] = []; const params: unknown[] = [id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
    if (b.name !== undefined) {
      const name = b.name.trim().replace(/\s+/g, ' ');
      if (!name) throw new EntryError('Proje adı boş olamaz');
      set('name', name);
    }
    if (b.code !== undefined) set('code', b.code?.trim() || null);
    if (b.customer !== undefined) set('customer', b.customer?.trim() ? (await addCustomer(db, u.employeeId, b.customer)).name : null);
    if (b.active !== undefined) set('active', b.active);
    if (!sets.length) return void res.json({ ok: true });
    await db.query(`UPDATE projects SET ${sets.join(',')} WHERE id=$1`, params);
    await audit(db, u.employeeId, 'project_update', id, { fields: sets.map((x) => x.split('=')[0]) });
    res.json({ ok: true });
  }));

  r.post('/api/projects/:id/plans', requireRole('PM'), wrap(async (req, res) => {
    const u = me(req);
    const id = uuid.parse(req.params.id);
    const b = z.object({ tenantId: z.string(), planId: z.string(), title: z.string().nullable().optional() }).parse(req.body);
    await assertOwnsProject(u, id);
    await db.tx(async (t) => {
      await claimPlan(t, id, b.tenantId, b.planId);
      await t.query(`INSERT INTO project_plans (project_id, tenant_id, plan_id, plan_title) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, plan_id) DO NOTHING`, [id, b.tenantId, b.planId, b.title ?? null]);
    });
    void syncTenant(db, graph, b.tenantId).catch((e) => console.error('planner sync after plan link failed', e));
    res.json({ ok: true });
  }));

  async function assertOwnsProject(u: User, projectId: string) {
    if (u.role === 'Admin') return;
    const ok = await db.query('SELECT 1 FROM projects WHERE id=$1 AND created_by=$2', [projectId, u.employeeId]);
    if (!ok.rows.length) throw new EntryError('Bu proje size ait değil', 403);
  }

  r.put('/api/projects/:id/members', requireRole('PM'), wrap(async (req, res) => {
    const u = me(req);
    const id = uuid.parse(req.params.id);
    const { employeeIds } = z.object({ employeeIds: z.array(uuid) }).parse(req.body);
    await assertOwnsProject(u, id);
    await db.tx(async (t) => {
      await t.query('DELETE FROM employee_projects WHERE project_id=$1', [id]);
      for (const e of employeeIds) await t.query('INSERT INTO employee_projects VALUES ($1,$2) ON CONFLICT DO NOTHING', [e, id]);
      await audit(t, u.employeeId, 'project_members', id, { count: employeeIds.length });
    });
    res.json({ ok: true });
  }));

  /** The cached Planner tasks of one project, so people can see what the sync actually brought in. */
  r.get('/api/projects/:id/tasks', requireRole('PM'), wrap(async (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json((await db.query(
      `SELECT t.id, t.title, t.bucket, t.due_date, t.percent_complete, t.synced_at,
              (SELECT coalesce(json_agg(e.name), '[]') FROM identities i JOIN employees e ON e.id = i.employee_id
                WHERE i.tenant_id = t.tenant_id AND i.entra_oid = ANY (t.assignee_oids)) AS assignees,
              cardinality(t.assignee_oids) AS assignee_count
         FROM planner_tasks t JOIN project_plans pp ON pp.tenant_id = t.tenant_id AND pp.plan_id = t.plan_id
        WHERE pp.project_id = $1 ORDER BY t.bucket NULLS LAST, t.title`, [id])).rows);
  }));

  /** Sync the plans of one project now and report what came back, errors included. */
  r.post('/api/projects/:id/sync', requireRole('PM'), wrap(async (req, res) => {
    const id = uuid.parse(req.params.id);
    await assertOwnsProject(me(req), id);
    const tenants = (await db.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM project_plans WHERE project_id=$1', [id])).rows;
    const results = [];
    for (const t of tenants) results.push(await syncTenant(db, graph, t.tenant_id));
    res.json(results);
  }));

  /* ---------- the project's own plan (tasks with dates), imported from Excel or edited with the assistant ---------- */

  r.get('/api/projects/:id/plan', wrap(async (req, res) => {
    const u = me(req);
    const id = uuid.parse(req.params.id);
    if (!atLeast(u, 'PM')) await assertAssigned(u, id);
    res.json(await listPlan(db, id));
  }));

  /** Read an Excel/CSV plan and stage it. Nothing is saved until the PM applies the proposal. */
  r.post('/api/projects/:id/plan/import', requireRole('PM'), upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new EntryError('Desteklenen dosya türleri: .xlsx, .csv');
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    res.json(await stagePlanImport(ctx, me(req), uuid.parse(req.params.id), name, req.file.buffer));
  }));

  /** Turn the project's linked Planner tasks into plan rows (staged, applied with one click). */
  r.post('/api/projects/:id/plan/from-planner', requireRole('PM'), wrap(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const tenants = (await db.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM project_plans WHERE project_id=$1', [id])).rows;
    for (const t of tenants) await syncTenant(db, graph, t.tenant_id).catch(() => undefined); // freshest state first
    res.json(await stagePlannerImport(ctx, me(req), id));
  }));

  /** Describe a change in words; the assistant proposes edits, code validates them, a click applies them. */
  r.post('/api/projects/:id/plan/assist', requireRole('PM'), wrap(async (req, res) => {
    const { instruction } = z.object({ instruction: z.string().min(1).max(2000) }).parse(req.body);
    res.json(await proposePlanEdit(ctx, me(req), uuid.parse(req.params.id), instruction));
  }));

  r.delete('/api/projects/:id/plan/:taskId', requireRole('PM'), wrap(async (req, res) => {
    await deletePlanTask(db, me(req), uuid.parse(req.params.id), uuid.parse(req.params.taskId));
    res.json({ ok: true });
  }));

  r.delete('/api/projects/:id/plan', requireRole('PM'), wrap(async (req, res) => {
    res.json({ deleted: await deleteWholePlan(db, me(req), uuid.parse(req.params.id)) });
  }));

  r.delete('/api/projects/:id/plans/:tenantId/:planId', requireRole('PM'), wrap(async (req, res) => {
    res.json({ removedTasks: await unlinkPlannerPlan(db, me(req), uuid.parse(req.params.id), String(req.params.tenantId), String(req.params.planId)) });
  }));

  r.delete('/api/projects/:id', requireRole('PM'), wrap(async (req, res) => {
    await archiveProject(db, me(req), uuid.parse(req.params.id));
    res.json({ ok: true });
  }));

  r.patch('/api/projects/:id/plan/:taskId', requireRole('PM'), wrap(async (req, res) => {
    const b = z.object({ status: z.string().optional(), due_date: z.string().nullable().optional(), owner: z.string().max(100).nullable().optional() }).parse(req.body);
    await patchPlanTask(db, me(req), uuid.parse(req.params.id), uuid.parse(req.params.taskId), b);
    res.json({ ok: true });
  }));

  /** Everything a person can log effort against: their Planner tasks, project plan tasks and tickets. */
  r.get('/api/my-tasks', wrap(async (req, res) => {
    const cands = await candidatesFor(db, me(req).employeeId, null);
    // Finished tickets can still be linked by "#number" in a file or chat, but are not offered as to-dos.
    res.json(cands.filter((c) => !(c.kind === 'itsm' && c.status === 'Kapalı')).map((c) => ({ kind: c.kind, id: c.id, title: c.title, section: c.extra ?? null, tenantId: c.tenantId || null, projectId: c.projectId, project: c.project ?? null, due: c.due ?? null, status: c.status ?? null })));
  }));

  r.get('/api/employees', requireRole('PM'), wrap(async (_req, res) => {
    res.json((await db.query(`SELECT e.id, e.name, e.email, e.role, e.day_hours, e.active,
        (SELECT coalesce(json_agg(json_build_object('tenantId', i.tenant_id, 'email', i.email, 'linked', i.entra_oid IS NOT NULL)), '[]') FROM identities i WHERE i.employee_id = e.id) AS identities
        FROM employees e ORDER BY e.name`)).rows);
  }));

  /** Seed the sample people (name, email, tenant) so identities can be matched on first sign-in. */
  r.post('/api/employees', requireRole('Admin'), wrap(async (req, res) => {
    const b = z.object({ people: z.array(z.object({ name: z.string().min(1), email: z.string().email(), tenantIds: z.array(z.string()).min(1), altEmails: z.record(z.string(), z.string().email()).optional() })).max(200) }).parse(req.body);
    let n = 0;
    await db.tx(async (t) => {
      for (const p of b.people) {
        const email = p.email.toLowerCase();
        const id = (await t.query<{ id: string }>(`INSERT INTO employees (name, email) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [p.name, email])).rows[0].id;
        for (const tid of p.tenantIds) {
          await t.query(`INSERT INTO tenants (id, name, domain) VALUES ($1,$1,'') ON CONFLICT DO NOTHING`, [tid]);
          await t.query(`INSERT INTO identities (employee_id, tenant_id, email) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, email) DO NOTHING`, [id, tid, (p.altEmails?.[tid] ?? email).toLowerCase()]);
        }
        n++;
      }
    });
    res.json({ people: n });
  }));

  r.patch('/api/employees/:id', requireRole('Admin'), wrap(async (req, res) => {
    const b = z.object({ dayHours: z.number().min(1).max(24).optional(), active: z.boolean().optional(), name: z.string().min(1).optional(), role: z.enum(['Employee', 'PM', 'Admin']).optional() }).parse(req.body);
    const id = uuid.parse(req.params.id);
    if (b.dayHours !== undefined) await db.query('UPDATE employees SET day_hours=$2 WHERE id=$1', [id, b.dayHours]);
    if (b.active !== undefined) await db.query('UPDATE employees SET active=$2 WHERE id=$1', [id, b.active]);
    if (b.name) await db.query('UPDATE employees SET name=$2 WHERE id=$1', [id, b.name]);
    if (b.role) {
      // An admin cannot remove their own admin role by accident and lock everyone out.
      if (id === me(req).employeeId && b.role !== 'Admin') throw new EntryError('Kendi yönetici rolünüzü kaldıramazsınız', 400);
      await db.query('UPDATE employees SET role=$2 WHERE id=$1', [id, b.role]);
    }
    await audit(db, me(req).employeeId, 'employee_edit', id, b);
    res.json({ ok: true });
  }));

  /** Link a second-tenant account to an existing employee, so their effort never splits in two. */
  r.post('/api/employees/:id/identities', requireRole('Admin'), wrap(async (req, res) => {
    const b = z.object({ tenantId: z.string(), email: z.string().email() }).parse(req.body);
    const id = uuid.parse(req.params.id);
    const email = b.email.toLowerCase();
    await db.tx(async (t) => {
      // If that account already signed in and got its own employee row, fold its effort into this one.
      const dup = (await t.query<{ employee_id: string }>(`SELECT employee_id FROM identities WHERE tenant_id=$1 AND lower(email)=$2`, [b.tenantId, email])).rows[0];
      if (dup && dup.employee_id !== id) {
        for (const tbl of ['entries', 'uploads', 'conversations', 'pending_actions'] as const) {
          await t.query(`UPDATE ${tbl} SET employee_id=$1 WHERE employee_id=$2`, [id, dup.employee_id]);
        }
        await t.query(`UPDATE report_definitions SET owner_id=$1 WHERE owner_id=$2`, [id, dup.employee_id]);
        await t.query(`DELETE FROM templates WHERE employee_id=$1`, [dup.employee_id]);
        await t.query(`UPDATE identities SET employee_id=$1 WHERE employee_id=$2`, [id, dup.employee_id]);
        await t.query(`DELETE FROM employee_projects WHERE employee_id=$1`, [dup.employee_id]);
        await t.query(`UPDATE employees SET active=false WHERE id=$1`, [dup.employee_id]);
      } else if (!dup) {
        await t.query(`INSERT INTO identities (employee_id, tenant_id, email) VALUES ($1,$2,$3)`, [id, b.tenantId, email]);
      }
      await audit(t, me(req).employeeId, 'identity_link', id, b);
    });
    res.json({ ok: true });
  }));

  /* ---------- Planner ---------- */

  r.get('/api/planner/plans', requireRole('PM'), wrap(async (req, res) => {
    const tenantId = z.string().parse(req.query.tenantId);
    const found = await discoverPlans(graph, tenantId);
    // Which of them are already taken, so the screen can show it.
    const taken = (await db.query<{ plan_id: string; name: string }>(`SELECT pp.plan_id, p.name FROM project_plans pp JOIN projects p ON p.id = pp.project_id AND p.active WHERE pp.tenant_id=$1`, [tenantId])).rows;
    res.json({ ...found, plans: found.plans.map((x) => ({ ...x, project: taken.find((t) => t.plan_id === x.id)?.name ?? null })) });
  }));

  /**
   * One project per Planner plan that no live project holds yet (all of them, or the chosen ones).
   * Meant for the first import; unwanted ones can be deleted afterwards.
   */
  r.post('/api/projects/from-plans', requireRole('PM'), wrap(async (req, res) => {
    const u = me(req);
    const b = z.object({ tenantId: z.string(), planIds: z.array(z.string()).max(200).optional() }).parse(req.body);
    const found = await discoverPlans(graph, b.tenantId);
    const wanted = found.plans.filter((p) => !b.planIds || b.planIds.includes(p.id));
    const created: string[] = [];
    let alreadyLinked = 0;
    for (const plan of wanted) {
      try {
        await db.tx(async (t) => {
          await claimPlan(t, null, b.tenantId, plan.id);
          if ((await t.query('SELECT 1 FROM project_plans WHERE tenant_id=$1 AND plan_id=$2', [b.tenantId, plan.id])).rows.length) throw new EntryError('taken', 409);
          const pid = (await t.query<{ id: string }>(`INSERT INTO projects (name, tenant_id, created_by) VALUES ($1,$2,$3) RETURNING id`, [plan.title.trim(), b.tenantId, u.employeeId])).rows[0].id;
          await t.query(`INSERT INTO project_plans (project_id, tenant_id, plan_id, plan_title) VALUES ($1,$2,$3,$4)`, [pid, b.tenantId, plan.id, plan.title.trim()]);
          await audit(t, u.employeeId, 'project_create', pid, { name: plan.title.trim(), bulk: true });
          created.push(plan.title.trim());
        });
      } catch (e) {
        if (e instanceof EntryError) alreadyLinked++; else throw e;
      }
    }
    if (created.length) void syncTenant(db, graph, b.tenantId).catch((e) => console.error('planner sync after bulk import failed', e));
    res.json({ created: created.length, alreadyLinked, names: created, skippedGroups: found.skipped.length });
  }));

  r.post('/api/planner/sync', requireRole('PM'), wrap(async (_req, res) => { res.json(await syncAll(db, graph)); }));

  /** Tickets for the Biletler page: an employee sees their own, a PM their team's, an admin everyone's. */
  r.get('/api/tickets', wrap(async (req, res) => {
    const q = z.object({ assignee: z.string().max(100).optional(), customer: z.string().max(100).optional(), open: z.enum(['0', '1']).optional() }).parse(req.query);
    const list = await openTickets(db, me(req), { assignee: q.assignee || null, customer: q.customer || null, onlyOpen: q.open !== '0', limit: 300 });
    const last = (await db.query(`SELECT last_run_at, last_status FROM job_runs WHERE name='itsm-sync'`)).rows[0] ?? null;
    const k = await currentItsmKey(ctx.vault);
    res.json({ ...list, connected: !!(ctx.itsm.baseUrl && ctx.itsm.tenantId && k.key), baseUrl: ctx.itsm.baseUrl, last, scope: me(req).role });
  }));

  /**
   * Full details of one ticket, fetched from ITSM when asked for. Only tickets the person may see
   * (their own, their team's, or everyone's for an admin) can be opened.
   */
  r.get('/api/tickets/:no', wrap(async (req, res) => {
    const no = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).parse(req.params.no);
    const u = me(req);
    if (!(await ticketVisible(db, u, no))) throw new EntryError('Bu bileti görme yetkiniz yok ya da bilet bulunamadı.', 404);
    const local = (await db.query<{ id: string; title: string; customer: string | null; status: string | null; assignee: string | null; sdp_id: string | null }>('SELECT id, title, customer, status, assignee, sdp_id FROM itsm_tickets WHERE id=$1', [no])).rows[0];
    const itsm = await loadItsm(ctx.itsm, ctx.vault);
    if (!itsm) return void res.json({ local, detail: null, error: 'ITSM bağlı değil.' });
    try {
      const detail = await itsm.detail(no, local?.sdp_id);
      if (detail && local && !local.sdp_id) await db.query('UPDATE itsm_tickets SET sdp_id=$2 WHERE id=$1', [no, detail.sdpId]);
      res.json({ local, detail, error: detail ? null : 'ITSM bu bileti bulamadı.' });
    } catch (e) {
      // The list stays usable even when ITSM is slow or refuses; say why.
      res.json({ local, detail: null, error: `ITSM sisteminden ayrıntılar alınamadı: ${(e as Error).message.slice(0, 200)}` });
    }
  }));

  /** ITSM connection state for the Yönetim page. The key itself is never sent to the browser. */
  r.get('/api/itsm', requireRole('Admin'), wrap(async (_req, res) => {
    const k = await currentItsmKey(ctx.vault);
    const last = (await db.query('SELECT last_run_at, last_status, last_detail FROM job_runs WHERE name=\'itsm-sync\'')).rows[0] ?? null;
    res.json({
      baseUrl: ctx.itsm.baseUrl, tenantId: ctx.itsm.tenantId, keySet: !!k.key, keyUpdatedAt: k.updatedAt,
      tickets: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM itsm_tickets')).rows[0].n, last,
    });
  }));

  /**
   * Save the ITSM API key. It is tried against ITSM first and only then written to Key Vault.
   * The key is never stored in the database, never logged and never returned.
   */
  r.post('/api/itsm/key', requireRole('Admin'), wrap(async (req, res) => {
    const { key } = z.object({ key: z.string().trim().min(8).max(300).regex(/^[^\s]+$/, 'Anahtarda boşluk olmamalı') }).parse(req.body);
    if (!ctx.itsm.baseUrl || !ctx.itsm.tenantId) throw new EntryError('ITSM adresi ve şirketi tanımlı değil (ITSM_BASE_URL, ITSM_TENANT_ID).', 409);
    const probe = ctx.itsm.make(key);
    try { await probe!.listChangedSince(new Date()); }
    catch (e) { throw new EntryError(`Anahtar ITSM tarafından kabul edilmedi: ${(e as Error).message.replace(key, '***')}`, 400); }
    try { await ctx.vault.set('itsm-api-key', key); }
    catch (e) { throw new EntryError(`Anahtar doğrulandı ama Key Vault'a yazılamadı: ${(e as Error).message}`, 502); }
    forgetItsmKey();
    await audit(db, me(req).employeeId, 'itsm_key_set', 'itsm-api-key'); // the event, never the value
    // Start reading tickets right away; the result shows up on the status line.
    const itsm = await loadItsm(ctx.itsm, ctx.vault);
    if (itsm) void runItsmSync(db, itsm, ctx.itsm.tenantId).catch((e) => console.error('first ITSM sync failed', e));
    res.json({ saved: true });
  }));

  /** Read the ticket system now and report what came back, errors included. Admin only. */
  r.post('/api/itsm/sync', requireRole('Admin'), wrap(async (_req, res) => {
    const itsm = await loadItsm(ctx.itsm, ctx.vault);
    if (!itsm || !ctx.itsm.tenantId) throw new EntryError('ITSM bağlantısı tamamlanmamış: adres, şirket ve API anahtarı gerekli.', 409);
    res.json(await runItsmSync(db, itsm, ctx.itsm.tenantId));
  }));

  r.get('/api/tenants', requireRole('PM'), wrap(async (_req, res) => {
    res.json((await db.query(`SELECT id, name, domain, graph_state, graph_checked_at, itsm_enabled FROM tenants ORDER BY name`)).rows);
  }));

  r.get('/api/status', requireRole('PM'), wrap(async (_req, res) => {
    const k = await currentItsmKey(ctx.vault);
    res.json({ jobs: (await db.query('SELECT * FROM job_runs')).rows, ai: ctx.ai.model, itsm: { configured: !!(ctx.itsm.baseUrl && ctx.itsm.tenantId && k.key), tickets: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM itsm_tickets')).rows[0].n } });
  }));

  /* ---------- reports ---------- */

  r.get('/api/reports/presets', wrap(async (req, res) => { res.json(presetsFor(me(req))); }));

  const runBody = z.object({ preset: z.string().optional(), definition: definitionSchema.optional(), from: z.string().optional(), to: z.string().optional() });
  async function resolveReport(req: Request) {
    const u = me(req);
    const b = runBody.parse(req.method === 'GET' ? JSON.parse(String(req.query.q ?? '{}')) : req.body);
    let title: string | undefined;
    let def = b.definition;
    if (b.preset) {
      const p = presetsFor(u).find((x) => x.id === b.preset) && PRESETS.find((x) => x.id === b.preset);
      if (!p) throw new EntryError('Bu rapor için yetkiniz yok', 403);
      def = p.build(today()); title = p.name;
      if (b.from) def.from = b.from;
      if (b.to) def.to = b.to;
    }
    if (!def) throw new EntryError('Rapor tanımı gerekli');
    return runReport(db, u, def, today(), title);
  }
  r.post('/api/reports/run', wrap(async (req, res) => { res.json(await resolveReport(req)); }));

  r.get('/api/reports/export', wrap(async (req, res) => {
    const result = await resolveReport(req);
    const fmt = req.query.format === 'pdf' ? 'pdf' : 'xlsx';
    const base = `efor-${result.from}_${result.to}`;
    await audit(db, me(req).employeeId, 'report_export', fmt, { title: result.title, from: result.from, to: result.to });
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${fmt}"`);
    if (fmt === 'pdf') { res.type('application/pdf').send(await reportToPdf(result)); }
    else { res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await reportToXlsx(result)); }
  }));

  r.get('/api/reports/saved', wrap(async (req, res) => {
    res.json((await db.query(`SELECT id, name, definition, schedule, last_run_at FROM report_definitions WHERE owner_id=$1 ORDER BY name`, [me(req).employeeId])).rows);
  }));

  const scheduleSchema = z.object({
    kind: z.enum(['monthly', 'weekly']), day: z.number().int().min(1).max(31), hour: z.number().int().min(0).max(23),
    recipients: z.array(z.string().email()).min(1).max(20),
  }).nullable();

  r.post('/api/reports/saved', wrap(async (req, res) => {
    const u = me(req);
    const b = z.object({ name: z.string().min(1).max(100), definition: definitionSchema, schedule: scheduleSchema.optional() }).parse(req.body);
    if (b.definition.kind === 'missing_days' && !atLeast(u, 'PM')) throw new EntryError('Yetkiniz yok', 403);
    if (b.schedule && !atLeast(u, 'PM')) throw new EntryError('Zamanlanmış rapor için yetkiniz yok', 403);
    const id = (await db.query<{ id: string }>(`INSERT INTO report_definitions (owner_id, name, definition, schedule) VALUES ($1,$2,$3,$4) RETURNING id`, [u.employeeId, b.name, JSON.stringify(b.definition), b.schedule ? JSON.stringify(b.schedule) : null])).rows[0].id;
    res.status(201).json({ id });
  }));

  r.delete('/api/reports/saved/:id', wrap(async (req, res) => {
    await db.query('DELETE FROM report_definitions WHERE id=$1 AND owner_id=$2', [uuid.parse(req.params.id), me(req).employeeId]);
    res.json({ ok: true });
  }));

  /* ---------- chat ---------- */

  r.get('/api/chat/conversations', wrap(async (req, res) => {
    res.json((await db.query(`SELECT id, title, created_at FROM conversations WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 30`, [me(req).employeeId])).rows);
  }));

  r.get('/api/chat/:id/messages', wrap(async (req, res) => {
    const u = me(req);
    const id = uuid.parse(req.params.id);
    const own = await db.query('SELECT 1 FROM conversations WHERE id=$1 AND employee_id=$2', [id, u.employeeId]);
    if (!own.rows.length) throw new EntryError('Sohbet bulunamadı', 404);
    res.json((await db.query(`SELECT role, content, card, created_at FROM messages WHERE conversation_id=$1 AND role IN ('user','assistant') ORDER BY created_at`, [id])).rows);
  }));

  r.post('/api/chat', upload.single('file'), wrap(async (req, res) => {
    const u = me(req);
    const text = String(req.body.message ?? '').slice(0, 4000);
    let cid = typeof req.body.conversationId === 'string' && req.body.conversationId ? uuid.parse(req.body.conversationId) : null;
    if (cid) {
      const own = await db.query('SELECT 1 FROM conversations WHERE id=$1 AND employee_id=$2', [cid, u.employeeId]);
      if (!own.rows.length) throw new EntryError('Sohbet bulunamadı', 404);
    } else {
      cid = (await db.query<{ id: string }>('INSERT INTO conversations (employee_id, title) VALUES ($1,$2) RETURNING id', [u.employeeId, text.slice(0, 60) || 'Yeni sohbet'])).rows[0].id;
    }
    try {
      let attached: Awaited<ReturnType<typeof chatFile>> | null = null;
      // The person can say which project an attached file belongs to; every row of it is then linked to that project.
      const projectId = typeof req.body.projectId === 'string' && req.body.projectId ? uuid.parse(req.body.projectId) : null;
      if (projectId) await assertAssigned(u, projectId);
      if (req.file) attached = await chatFile(ctx, u, cid, Buffer.from(req.file.originalname, 'latin1').toString('utf8'), req.file.buffer, text, projectId);
      if (attached && !text.trim()) return void res.json({ conversationId: cid, ...attached });
      const turn = await chatTurn(ctx, u, cid, text || 'Dosyayı yükledim.', attached?.cards ?? []);
      res.json({ conversationId: cid, reply: turn.reply, cards: [...(attached?.cards ?? []), ...turn.cards.filter((c) => !attached?.cards.includes(c))] });
    } catch (e) {
      if (e instanceof DuplicateUploadError) return void res.status(409).json({ error: e.message, uploadId: e.existingId, conversationId: cid });
      throw e;
    }
  }));

  r.post('/api/pending/:id/apply', wrap(async (req, res) => { res.json(await applyPending(ctx, me(req), uuid.parse(req.params.id))); }));
  r.post('/api/pending/:id/cancel', wrap(async (req, res) => { await cancelPending(ctx, me(req), uuid.parse(req.params.id)); res.json({ ok: true }); }));

  /* ---------- admin ---------- */

  r.post('/api/admin/period', requireRole('Admin'), wrap(async (req, res) => {
    const b = z.object({ closedBefore: z.string().regex(/^\d{4}-\d\d-\d\d$/) }).parse(req.body);
    await db.query('INSERT INTO periods (closed_before, set_by) VALUES ($1,$2)', [b.closedBefore, me(req).employeeId]);
    await audit(db, me(req).employeeId, 'period_close', b.closedBefore);
    res.json({ ok: true });
  }));

  r.get('/api/admin/audit', requireRole('Admin'), wrap(async (_req, res) => {
    res.json((await db.query(`SELECT a.id, a.at, e.name AS actor, a.action, a.target, a.detail FROM audit_events a LEFT JOIN employees e ON e.id = a.actor_id ORDER BY a.id DESC LIMIT 200`)).rows);
  }));

  // Errors: known domain errors keep their status; validation errors are 400; the rest never leak details.
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof EntryError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof AssistantUnavailable) return void res.status(502).json({ error: err.message });
    if (err instanceof UnreadableFileError) return void res.status(422).json({ error: err.message });
    if (err instanceof z.ZodError) return void res.status(400).json({ error: 'Geçersiz istek', detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof multer.MulterError) return void res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Dosya 10 MB sınırını aşıyor' : err.message });
    console.error(err);
    res.status(500).json({ error: 'Beklenmeyen bir hata oluştu' });
  });
  return r;
}
