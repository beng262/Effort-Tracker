import { createHash, randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { audit } from './access.js';
import { config } from './config.js';
import type { Ctx } from './context.js';
import type { Db } from './db.js';
import { EntryError } from './entries.js';
import { atLeast, requireUser, type User } from './session.js';

/**
 * A storage place on every project: the people on the project (and project managers and admins) add and download its
 * files. The bytes live in the blob store, never in the database; the database keeps the list. Files are always sent back
 * as downloads (never shown in the page), so an uploaded document can never run as part of the app.
 */

const uuid = z.string().uuid();
const MAX_AT_ONCE = 10;
export const maxFileBytes = () => config.PROJECT_FILE_MAX_MB * 1024 * 1024;

/** The name a person sees: no path, no control characters, no leading dots, at most 200 characters (the end is kept, so the extension stays). */
export function cleanFileName(raw: string): string {
  const base = raw.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.trim().replace(/^\.+/, '').trim();
  return base.slice(-200) || 'dosya';
}

/** Who may use a project's files: its team, project managers and admins. Returns the project's creator for delete checks. */
export async function projectAccess(db: Db, u: User, projectId: string): Promise<{ createdBy: string | null }> {
  const p = (await db.query<{ created_by: string | null }>('SELECT created_by FROM projects WHERE id=$1', [projectId])).rows[0];
  if (!p) throw new EntryError('Proje bulunamadı', 404);
  if (!atLeast(u, 'PM')) {
    const ok = await db.query('SELECT 1 FROM employee_projects WHERE employee_id=$1 AND project_id=$2', [u.employeeId, projectId]);
    if (!ok.rows.length) throw new EntryError('Bu proje size atanmamış', 403);
  }
  return { createdBy: p.created_by };
}

export interface ProjectFile { id: string; name: string; size: number; note: string | null; uploadedAt: string; uploader: string; canDelete: boolean }

export async function listProjectFiles(db: Db, u: User, projectId: string): Promise<ProjectFile[]> {
  const { createdBy } = await projectAccess(db, u, projectId);
  const rows = (await db.query<{ id: string; name: string; size_bytes: string; note: string | null; uploaded_at: string; uploader: string; uploaded_by: string }>(
    `SELECT f.id, f.name, f.size_bytes, f.note, f.uploaded_at, f.uploaded_by, e.name AS uploader
       FROM project_files f JOIN employees e ON e.id = f.uploaded_by
      WHERE f.project_id=$1 AND NOT f.deleted ORDER BY f.uploaded_at DESC, f.name`, [projectId])).rows;
  return rows.map((r) => ({
    id: r.id, name: r.name, size: Number(r.size_bytes), note: r.note, uploadedAt: r.uploaded_at, uploader: r.uploader,
    canDelete: r.uploaded_by === u.employeeId || u.role === 'Admin' || createdBy === u.employeeId,
  }));
}

/** Store one file. An identical file (same bytes) already on the project is not stored twice. */
export async function addProjectFile(ctx: Ctx, u: User, projectId: string, rawName: string, buf: Buffer, note?: string | null): Promise<{ status: 'added' | 'duplicate'; id: string; name: string }> {
  await projectAccess(ctx.db, u, projectId);
  if (!buf.length) throw new EntryError('Dosya boş');
  if (buf.length > maxFileBytes()) throw new EntryError(`Dosya ${config.PROJECT_FILE_MAX_MB} MB sınırını aşıyor`);
  const name = cleanFileName(rawName);
  const sha = createHash('sha256').update(buf).digest('hex');
  const dup = (await ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM project_files WHERE project_id=$1 AND sha256=$2 AND NOT deleted', [projectId, sha])).rows[0];
  if (dup) return { status: 'duplicate', id: dup.id, name: dup.name };
  const id = randomUUID();
  // The storage path is made by the server from ids and a plain-ASCII form of the name, never taken from the browser.
  const blobPath = `projects/${projectId}/${id}/${name.replace(/[^\w.\-]+/g, '_')}`;
  await ctx.blob.put(blobPath, buf);
  await ctx.db.query(
    `INSERT INTO project_files (id, project_id, name, size_bytes, sha256, blob_path, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, projectId, name, buf.length, sha, blobPath, note?.trim() ? note.trim().slice(0, 300) : null, u.employeeId]);
  await audit(ctx.db, u.employeeId, 'project_file_add', projectId, { name, size: buf.length });
  return { status: 'added', id, name };
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { fn(req, res).catch(next); };

export function projectFilesRouter(ctx: Ctx): Router {
  const r = Router();
  const me = (req: Request) => req.user as User;
  const upl = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileBytes(), files: MAX_AT_ONCE } }).array('file', MAX_AT_ONCE);
  const receive = (req: Request, res: Response, next: NextFunction) => upl(req, res, (err: unknown) => {
    if (!err) return next();
    const m = err as { code?: string; message?: string };
    res.status(400).json({ error: m.code === 'LIMIT_FILE_SIZE' ? `Dosya ${config.PROJECT_FILE_MAX_MB} MB sınırını aşıyor` : m.code === 'LIMIT_UNEXPECTED_FILE' || m.code === 'LIMIT_FILE_COUNT' ? `Bir seferde en fazla ${MAX_AT_ONCE} dosya yüklenebilir` : (m.message ?? 'Yükleme başarısız') });
  });

  r.get('/api/projects/:id/files', requireUser, wrap(async (req, res) => {
    res.json(await listProjectFiles(ctx.db, me(req), uuid.parse(req.params.id)));
  }));

  r.post('/api/projects/:id/files', requireUser, receive, wrap(async (req, res) => {
    const projectId = uuid.parse(req.params.id);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new EntryError('Dosya seçilmedi');
    const note = typeof req.body?.note === 'string' ? req.body.note : null;
    const added: { id: string; name: string }[] = []; const skipped: { name: string; reason: string }[] = [];
    for (const f of files) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        const r2 = await addProjectFile(ctx, me(req), projectId, name, f.buffer, note);
        if (r2.status === 'added') added.push({ id: r2.id, name: r2.name }); else skipped.push({ name: cleanFileName(name), reason: `“${r2.name}” olarak zaten yüklü` });
      } catch (e) {
        if (e instanceof EntryError && e.status !== 403 && e.status !== 404) skipped.push({ name: cleanFileName(name), reason: e.message }); else throw e;
      }
    }
    res.status(added.length ? 201 : 200).json({ added, skipped });
  }));

  r.get('/api/projects/:id/files/:fileId/download', requireUser, wrap(async (req, res) => {
    const projectId = uuid.parse(req.params.id);
    await projectAccess(ctx.db, me(req), projectId);
    const f = (await ctx.db.query<{ name: string; blob_path: string }>('SELECT name, blob_path FROM project_files WHERE id=$1 AND project_id=$2 AND NOT deleted', [uuid.parse(req.params.fileId), projectId])).rows[0];
    if (!f) throw new EntryError('Dosya bulunamadı', 404);
    const data = await ctx.blob.get(f.blob_path);
    // Always a download, never inline, whatever the file claims to be.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(data);
  }));

  r.delete('/api/projects/:id/files/:fileId', requireUser, wrap(async (req, res) => {
    const u = me(req);
    const projectId = uuid.parse(req.params.id);
    const { createdBy } = await projectAccess(ctx.db, u, projectId);
    const f = (await ctx.db.query<{ id: string; name: string; blob_path: string; uploaded_by: string }>('SELECT id, name, blob_path, uploaded_by FROM project_files WHERE id=$1 AND project_id=$2 AND NOT deleted', [uuid.parse(req.params.fileId), projectId])).rows[0];
    if (!f) throw new EntryError('Dosya bulunamadı', 404);
    if (!(f.uploaded_by === u.employeeId || u.role === 'Admin' || createdBy === u.employeeId)) throw new EntryError('Dosyayı yalnızca yükleyen, projeyi oluşturan ya da yönetici silebilir', 403);
    await ctx.db.query('UPDATE project_files SET deleted=true WHERE id=$1', [f.id]);
    await ctx.blob.remove?.(f.blob_path).catch(() => { /* the row is already gone from the list; a leftover blob is harmless */ });
    await audit(ctx.db, u.employeeId, 'project_file_delete', projectId, { name: f.name });
    res.json({ ok: true });
  }));

  return r;
}
