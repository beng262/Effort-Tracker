import { createHash } from 'node:crypto';
import { applyMappings, layoutFingerprint, preRead } from '../core/grid.js';
import { acceptModelPick, linkRow } from '../core/link.js';
import { isBlocking, normalise, rowKey, type NormaliseResult } from '../core/normalise.js';
import { fold, weekFromFileName } from '../core/turkish.js';
import { parseStandardSheet, sameName } from '../core/standard.js';
import type { Candidate, ColumnMapping, LinkResult, NormalisedRow, ProposedRow } from '../core/types.js';
import { audit } from './access.js';
import { EXTRACT_PROMPT_VERSION } from './ai.js';
import type { Ctx } from './context.js';
import type { Db } from './db.js';
import { recomputeDays } from './overtime.js';
import { CLOSED_STATUS } from './workload.js';

/** The file could not be opened as the type its name claims (a damaged or renamed file). */
export class UnreadableFileError extends Error {}

export class DuplicateUploadError extends Error {
  constructor(public existingId: string) { super('Bu dosya daha önce yüklenmiş'); }
}

export interface UploadInput {
  employeeId: string;
  dayHours: number;
  projectId?: string | null;
  channel: 'page' | 'chat' | 'text';
  fileName: string;
  buf: Buffer;
  /** Mixed into the file hash so identical chat sentences sent on different days are not refused. */
  salt?: string;
}

interface ProjectRef { id: string; name: string }

async function personProjects(db: Db, employeeId: string): Promise<ProjectRef[]> {
  return (await db.query<ProjectRef>(
    `SELECT p.id, p.name FROM projects p JOIN employee_projects ep ON ep.project_id = p.id
      WHERE ep.employee_id = $1 AND p.active ORDER BY p.name`, [employeeId])).rows;
}

/** Project for a row: explicit hint by name, else the only project the person has, else unknown. */
export function inferProject(hint: string | null, projects: ProjectRef[], forced?: string | null): string | null {
  if (forced) return forced;
  if (hint) {
    const h = fold(hint);
    const hit = projects.filter((p) => fold(p.name) === h || fold(p.name).includes(h) || h.includes(fold(p.name)));
    if (hit.length === 1) return hit[0].id;
  }
  return projects.length === 1 ? projects[0].id : null;
}

export type CandidateWithTenant = Candidate & { tenantId: string; projectId: string | null; project?: string | null; due?: string | null; status?: string | null };

/**
 * The person's Planner tasks, project-plan tasks and tickets that effort can be linked to.
 * The three queries run at the same time (the database is in another region, so each round trip is slow),
 * and each one returns what the task list shows, so no follow-up queries are needed.
 * `projectIds` null means "the projects this person is a member of".
 */
export async function candidatesFor(db: Db, employeeId: string, projectIds: string[] | null): Promise<CandidateWithTenant[]> {
  if (projectIds && !projectIds.length) return [];
  const scope = projectIds ? '= ANY ($2::uuid[])' : 'IN (SELECT project_id FROM employee_projects WHERE employee_id = $1)';
  const args = (extra: unknown[] = []) => (projectIds ? [employeeId, projectIds, ...extra] : [employeeId, ...extra]);

  const [tasks, own, tickets] = await Promise.all([
    db.query<{ id: string; title: string; bucket: string | null; tenant_id: string; project_id: string; project: string; due_date: string | null; mine: boolean }>(
      `SELECT t.id, t.title, t.bucket, t.tenant_id, pp.project_id, pr.name AS project, t.due_date,
              EXISTS (SELECT 1 FROM identities i WHERE i.employee_id = $1 AND i.tenant_id = t.tenant_id AND i.entra_oid = ANY (t.assignee_oids)) AS mine
         FROM planner_tasks t JOIN project_plans pp ON pp.tenant_id = t.tenant_id AND pp.plan_id = t.plan_id JOIN projects pr ON pr.id = pp.project_id AND pr.active
        WHERE pp.project_id ${scope} AND t.percent_complete < 100`, args()),
    db.query<{ id: string; ext_id: string; title: string; section: string | null; project_id: string; project: string; due_date: string | null; status: string; mine: boolean }>(
      `SELECT t.id::text AS id, t.ext_id, t.title, t.section, t.project_id, pr.name AS project, t.due_date, t.status, (t.owner_id = $1) AS mine
         FROM project_tasks t JOIN projects pr ON pr.id = t.project_id AND pr.active
        WHERE t.project_id ${scope} AND t.status <> 'Tamamlandı' ORDER BY t.position`, args()),
    db.query<{ id: string; title: string; customer: string | null; tenant_id: string; status: string | null; closed_at: string | null }>(
      `SELECT k.id, k.title, k.customer, k.tenant_id, k.status, k.closed_at
         FROM itsm_tickets k JOIN identities i ON i.employee_id = $1
        WHERE (k.assignee IS NOT NULL AND (k.assignee = lower(i.email) OR k.assignee = i.itsm_user_id))
          AND (k.closed_at IS NULL OR k.closed_at > now() - interval '45 days')`, [employeeId]),
  ]);

  const out: CandidateWithTenant[] = [];
  // The person's own tasks first; when a project has none assigned to them, all of the project's tasks.
  const group = <T extends { project_id: string; mine: boolean }>(rows: T[]) => {
    const by = new Map<string, T[]>();
    for (const t of rows) by.set(t.project_id, [...(by.get(t.project_id) ?? []), t]);
    return [...by.values()].flatMap((list) => { const mine = list.filter((t) => t.mine); return mine.length ? mine : list; });
  };
  for (const t of group(tasks.rows)) out.push({ kind: 'planner', id: t.id, title: t.title, extra: t.bucket ?? undefined, tenantId: t.tenant_id, projectId: t.project_id, project: t.project, due: t.due_date, status: null });
  for (const t of group(own.rows)) out.push({ kind: 'project', id: t.id, code: t.ext_id, title: `${t.ext_id} ${t.title}`, extra: t.section ?? undefined, tenantId: '', projectId: t.project_id, project: t.project, due: t.due_date, status: t.status });
  for (const k of tickets.rows) out.push({ kind: 'itsm', id: k.id, title: k.title, extra: k.customer ?? undefined, tenantId: k.tenant_id, projectId: null, project: null, due: null, status: k.closed_at || new RegExp(CLOSED_STATUS, 'i').test(k.status ?? '') ? 'Kapalı' : (k.status ?? null) });
  return out;
}

export interface DraftRow {
  row: NormalisedRow;
  projectId: string | null;
  link: LinkResult;
  linkTenant: string | null;
}

export async function linkAll(ctx: Ctx, employeeId: string, rows: NormalisedRow[], forcedProject: string | null | undefined): Promise<DraftRow[]> {
  const projects = await personProjects(ctx.db, employeeId);
  const prepared = rows.map((row) => ({ row, projectId: inferProject(row.projectHint, projects, forcedProject) }));
  const all = await candidatesFor(ctx.db, employeeId, projects.map((p) => p.id));
  const drafts: DraftRow[] = prepared.map(({ row, projectId }) => {
    const pool = projectId ? all.filter((c) => c.kind === 'itsm' || c.projectId === projectId) : all;
    const link = linkRow(row, pool);
    const chosen = link.id ? pool.find((c) => c.id === link.id) : undefined;
    return { row, projectId, link, linkTenant: chosen?.tenantId || null };
  });

  // The model may choose, but only among options it was shown.
  const needPick = drafts.map((d, i) => ({ d, key: String(i) })).filter(({ d }) => !d.link.id && d.link.options.length > 1);
  if (needPick.length && ctx.ai.model !== 'unconfigured') {
    try {
      const picks = await ctx.ai.pick(needPick.map(({ d, key }) => ({ key, text: `${d.row.description} ${d.row.taskHint ?? ''}`.trim(), options: d.link.options })));
      for (const { d, key } of needPick) {
        const c = acceptModelPick(picks[key], d.link.options);
        if (c) {
          d.link = { kind: c.kind, id: c.id, score: d.link.score, via: 'model', options: d.link.options };
          d.linkTenant = all.find((x) => x.id === c.id)?.tenantId || null;
        }
      }
    } catch { /* leaving rows unlinked is always safe */ }
  }
  return drafts;
}

export async function closedBefore(db: Db): Promise<string | undefined> {
  const r = await db.query<{ closed_before: string }>('SELECT max(closed_before) AS closed_before FROM periods');
  return r.rows[0]?.closed_before ?? undefined;
}

export async function existingKeys(db: Db, employeeId: string, fromDate?: string): Promise<Set<string>> {
  const rows = (await db.query<{ work_date: string; hours: number; description: string }>(
    `SELECT work_date, hours, description FROM entries WHERE employee_id=$1 AND NOT deleted AND status <> 'draft'
       AND ($2::date IS NULL OR work_date >= $2::date)`, [employeeId, fromDate ?? null])).rows;
  return new Set(rows.map((r) => rowKey(r.work_date, r.hours, r.description)));
}

export async function insertDrafts(db: Db, employeeId: string, uploadId: string | null, drafts: DraftRow[], origin: 'template' | 'model' | 'chat' | 'manual'): Promise<string[]> {
  const ids: string[] = [];
  for (const d of drafts) {
    const r = d.row;
    const res = await db.query<{ id: string }>(
      `INSERT INTO entries (employee_id, project_id, upload_id, work_date, start_time, end_time, hours, hours_rule, description,
         link_kind, link_id, link_tenant, link_score, link_via, link_options, task_hint, ticket_hint, project_hint,
         flags, confidence, source, source_text, origin, category, customer, work_item, product, outcome, progress)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
      [employeeId, d.projectId, uploadId, r.date, r.startTime, r.endTime, r.hours, r.hoursRule, r.description,
        d.link.kind, d.link.id, d.linkTenant, d.link.score || null, d.link.via === 'none' ? null : d.link.via, JSON.stringify(d.link.options),
        r.taskHint, r.ticketHint, r.projectHint, r.flags, r.confidence, r.source, r.sourceText, origin,
        r.extras?.category ?? null, r.extras?.customer ?? null, r.extras?.work_item ?? null, r.extras?.product ?? null, r.extras?.outcome ?? null, r.extras?.progress ?? null]);
    ids.push(res.rows[0].id);
  }
  await recomputeDays(db, drafts.map((d) => ({ employeeId, date: d.row.date })));
  return ids;
}

export interface UploadResult { uploadId: string; path: 'standard' | 'template' | 'ai' | 'text-ai'; rows: number; notes: string[] }

export async function processUpload(ctx: Ctx, input: UploadInput): Promise<UploadResult> {
  const { db } = ctx;
  const today = ctx.today();
  const sha256 = createHash('sha256').update(input.buf).update(input.salt ?? '').digest('hex');
  const weekStart = weekFromFileName(input.fileName, today);

  let uploadId: string;
  try {
    uploadId = (await db.query<{ id: string }>(
      `INSERT INTO uploads (employee_id, project_id, channel, file_name, sha256, week_start) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.employeeId, input.projectId ?? null, input.channel, input.fileName, sha256, weekStart])).rows[0].id;
  } catch (e) {
    const dup = (await db.query<{ id: string }>(
      `SELECT id FROM uploads WHERE employee_id=$1 AND sha256=$2 AND status IN ('processing','review','confirmed')`, [input.employeeId, sha256])).rows[0];
    if (dup) throw new DuplicateUploadError(dup.id);
    throw e;
  }

  try {
    const blobPath = `${input.employeeId}/${uploadId}/${input.fileName.replace(/[^\w.\-]+/g, '_')}`;
    await ctx.blob.put(blobPath, input.buf);
    await db.query('UPDATE uploads SET blob_path=$1 WHERE id=$2', [blobPath, uploadId]);

    let pre;
    try { pre = await preRead(input.fileName, input.buf); }
    catch (e) {
      if (/\.xls$/i.test(input.fileName)) throw e; // already a clear message
      throw new UnreadableFileError('Dosya açılamadı. Bozuk olabilir ya da gerçek bir Excel (.xlsx) dosyası olmayabilir. Dosyayı Excel ile açıp yeniden .xlsx olarak kaydetmeyi deneyin.');
    }
    const fingerprint = layoutFingerprint(pre);
    const projects = await personProjects(db, input.employeeId);

    let proposed: ProposedRow[];
    let path: UploadResult['path'];
    let model: string | null = null;
    let mappings: ColumnMapping[] = [];
    let aiNotes: string[] = [];
    let templateId: string | null = null;

    // The standard daily form is read by fixed rules: no template lookup, no model.
    const standard = pre.kind === 'text' ? null : parseStandardSheet(pre);
    const tpl = standard ? undefined : fingerprint
      ? (await db.query<{ id: string; mappings: ColumnMapping[] }>(`SELECT id, mappings FROM templates WHERE employee_id=$1 AND fingerprint=$2`, [input.employeeId, fingerprint])).rows[0]
      : undefined;
    if (standard) {
      proposed = standard.rows;
      path = 'standard';
      aiNotes = standard.notes;
    } else if (tpl) {
      proposed = applyMappings(pre, tpl.mappings);
      path = 'template';
      templateId = tpl.id;
      await db.query('UPDATE templates SET times_used = times_used + 1 WHERE id=$1', [tpl.id]);
    } else {
      const ex = await ctx.ai.extract({ own: input.channel === 'text', fileName: input.fileName, kind: pre.kind, compact: pre.compact, weekStart, today, projects: projects.map((p) => p.name) });
      proposed = ex.rows;
      mappings = pre.kind === 'text' ? [] : ex.mappings;
      aiNotes = ex.notes;
      path = pre.kind === 'text' ? 'text-ai' : 'ai';
      model = ctx.ai.model;
    }

    const result = await buildDrafts(ctx, input, proposed, weekStart, today);
    if (standard) {
      // The form names who did the work. Effort is always saved for the person uploading, so a different name is a warning.
      const who = (await db.query<{ name: string }>('SELECT name FROM employees WHERE id=$1', [input.employeeId])).rows[0]?.name;
      for (const d of result.drafts) if (!sameName(d.row.employee, who)) d.row.flags.push('name_mismatch');
    }
    const ids = await insertDrafts(db, input.employeeId, uploadId, result.drafts, path === 'template' ? 'template' : 'model');
    const notes = [...result.norm.notes, ...aiNotes, ...(pre.truncated ? ['Dosya çok uzun olduğu için bir kısmı okunmadı.'] : [])];
    await db.query(
      `UPDATE uploads SET status='review', path_taken=$2, model=$3, prompt_version=$4, template_id=$5, proposed_mappings=$6, notes=$7, fingerprint=$8 WHERE id=$1`,
      [uploadId, path, model, model ? EXTRACT_PROMPT_VERSION : null, templateId, mappings.length ? JSON.stringify(mappings) : null, JSON.stringify(notes), standard ? null : fingerprint]);
    await audit(db, input.employeeId, 'upload', uploadId, { path, rows: ids.length, channel: input.channel });
    return { uploadId, path, rows: ids.length, notes };
  } catch (e) {
    await db.query(`UPDATE uploads SET status='failed', error=$2 WHERE id=$1`, [uploadId, (e as Error).message]);
    throw e;
  }
}

/** Normalise and link proposed rows for one person. Shared by uploads and the chat's text path. */
export async function buildDrafts(ctx: Ctx, input: Pick<UploadInput, 'employeeId' | 'dayHours' | 'projectId'>, proposed: ProposedRow[], weekStart: string, today: string): Promise<{ drafts: DraftRow[]; norm: NormaliseResult }> {
  const norm = normalise(proposed, {
    weekStart, year: Number(weekStart.slice(0, 4)), month: Number(weekStart.slice(5, 7)), today, dayHours: input.dayHours,
    existingKeys: await existingKeys(ctx.db, input.employeeId, weekStart.slice(0, 7) + '-01'),
    closedBefore: await closedBefore(ctx.db),
  });
  const drafts = await linkAll(ctx, input.employeeId, norm.rows, input.projectId);
  return { drafts, norm };
}

export class NotConfirmable extends Error {}

/**
 * Confirm a reviewed upload. Rows with blocking flags must have been fixed or discarded first.
 * This is the only path from draft to confirmed; the model can never reach it.
 */
export async function confirmUpload(db: Db, employeeId: string, uploadId: string): Promise<{ confirmed: number }> {
  return db.tx(async (t) => {
    const up = (await t.query<{ status: string; fingerprint: string | null; proposed_mappings: ColumnMapping[] | null }>(
      `SELECT status, fingerprint, proposed_mappings FROM uploads WHERE id=$1 AND employee_id=$2 FOR UPDATE`, [uploadId, employeeId])).rows[0];
    if (!up) throw new NotConfirmable('Yükleme bulunamadı');
    if (up.status !== 'review') throw new NotConfirmable('Bu yükleme zaten işlenmiş');
    const rows = (await t.query<{ id: string; flags: string[]; work_date: string | null; hours: number | null }>(
      `SELECT id, flags, work_date, hours FROM entries WHERE upload_id=$1 AND NOT deleted`, [uploadId])).rows;
    if (!rows.length) throw new NotConfirmable('Onaylanacak satır yok');
    const blocked = rows.filter((r) => r.work_date === null || r.hours === null || isBlockedFlags(r.flags));
    if (blocked.length) throw new NotConfirmable(`${blocked.length} satır düzeltilmeden onaylanamaz`);
    const r = await t.query(`UPDATE entries SET status='confirmed', confirmed_at=now() WHERE upload_id=$1 AND NOT deleted AND status='draft'`, [uploadId]);
    await t.query(`UPDATE uploads SET status='confirmed' WHERE id=$1`, [uploadId]);
    // A layout the person confirmed becomes a template, so the next upload of it needs no model.
    if (up.fingerprint && up.proposed_mappings?.length) {
      await t.query(
        `INSERT INTO templates (fingerprint, employee_id, mappings) VALUES ($1,$2,$3) ON CONFLICT (employee_id, fingerprint) DO NOTHING`,
        [up.fingerprint, employeeId, JSON.stringify(up.proposed_mappings)]);
    }
    await audit(t, employeeId, 'confirm_upload', uploadId, { rows: (r as any).rowCount ?? rows.length });
    return { confirmed: rows.length };
  });
}

const BLOCKING = ['no_date', 'no_effort', 'zero_effort', 'number_not_in_source', 'closed_period', 'duplicate'];
const isBlockedFlags = (flags: string[]) => flags.some((f) => BLOCKING.includes(f));
export { isBlocking };
