import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { addDays, fold } from '../core/turkish.js';
import { audit } from './access.js';
import { config } from './config.js';
import type { Ctx } from './context.js';
import type { Db } from './db.js';
import { confirmEntries, createEntry, EntryError } from './entries.js';
import { clearCookie, openToken, parseCookies, requireUser, sealToken, setCookie, atLeast, type User } from './session.js';

/**
 * Calendar meetings as effort. The person connects their own calendar once (delegated Microsoft Graph permission
 * Calendars.Read, so only their own calendar can ever be read), the app lists meetings of a week, and the person ticks
 * the ones to add. Nothing becomes effort without that click, and a meeting is never added twice.
 */

/* ---------- Graph and the token endpoint (replaced by a fake in tests) ---------- */

export interface GraphEvent {
  id: string; subject: string | null; isAllDay: boolean; isCancelled: boolean; showAs: string;
  isOnlineMeeting?: boolean; start: { dateTime: string }; end: { dateTime: string };
  organizer?: { emailAddress?: { name?: string } }; attendees?: unknown[]; responseStatus?: { response?: string };
}

export interface CalendarApi {
  authorizeUrl(p: { tenantId: string; state: string; challenge: string; loginHint: string; redirectUri: string }): string;
  exchangeCode(p: { tenantId: string; code: string; verifier: string; redirectUri: string }): Promise<{ refreshToken: string; accessToken: string; tid: string | null; oid: string | null }>;
  refresh(p: { tenantId: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken: string }>;
  /** Events between two instants, in the Istanbul time zone. */
  events(accessToken: string, from: string, to: string): Promise<GraphEvent[]>;
}

const SCOPE = 'openid offline_access Calendars.Read';
export class InvalidGrant extends Error {}

export function createCalendarApi(f: typeof fetch = fetch): CalendarApi {
  const tokenUrl = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  async function token(tenantId: string, form: Record<string, string>) {
    const r = await f(tokenUrl(tenantId), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.ENTRA_CLIENT_ID!, client_secret: config.ENTRA_CLIENT_SECRET!, ...form }),
    });
    const b: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (b.error === 'invalid_grant') throw new InvalidGrant(b.error_description ?? 'invalid_grant');
      throw new Error(`Takvim izni alınamadı: ${String(b.error_description ?? b.error ?? r.status).slice(0, 200)}`);
    }
    return b;
  }
  return {
    authorizeUrl: ({ tenantId, state, challenge, loginHint, redirectUri }) => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` + new URLSearchParams({
      client_id: config.ENTRA_CLIENT_ID ?? '', response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', login_hint: loginHint,
    }),
    async exchangeCode({ tenantId, code, verifier, redirectUri }) {
      const b = await token(tenantId, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, scope: SCOPE });
      if (!b.refresh_token) throw new Error('Takvim izni alınamadı: yenileme anahtarı gelmedi (offline_access izni eksik olabilir).');
      let tid: string | null = null; let oid: string | null = null;
      if (typeof b.id_token === 'string') {
        // Received straight from the token endpoint over TLS with our client secret, so it is read, not re-verified.
        try { const p = JSON.parse(Buffer.from(b.id_token.split('.')[1], 'base64url').toString()); tid = p.tid ?? null; oid = p.oid ?? null; } catch { /* no claims */ }
      }
      return { refreshToken: b.refresh_token, accessToken: b.access_token, tid, oid };
    },
    async refresh({ tenantId, refreshToken }) {
      const b = await token(tenantId, { grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPE });
      // Entra rotates refresh tokens: keep the new one when it comes, the old one otherwise.
      return { accessToken: b.access_token, refreshToken: b.refresh_token ?? refreshToken };
    },
    async events(accessToken, from, to) {
      const out: GraphEvent[] = [];
      let url: string | null = `https://graph.microsoft.com/v1.0/me/calendarView?` + new URLSearchParams({
        startDateTime: from, endDateTime: to, $top: '100', $orderby: 'start/dateTime',
        $select: 'id,subject,start,end,isAllDay,isCancelled,showAs,isOnlineMeeting,organizer,attendees,responseStatus',
      });
      for (let page = 0; url && page < 10; page++) {
        const r: globalThis.Response = await f(url, { headers: { authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="Europe/Istanbul"' } });
        if (!r.ok) throw new Error(`Takvim okunamadı (Graph ${r.status}): ${(await r.text()).slice(0, 200)}`);
        const b: any = await r.json();
        out.push(...(b.value ?? []));
        url = b['@odata.nextLink'] ?? null;
      }
      return out;
    },
  };
}

/* ---------- sealing the refresh token ---------- */

const key = () => Buffer.from(hkdfSync('sha256', config.SESSION_SECRET, 'efor-calendar', 'refresh-token', 32));

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function openSecret(sealed: string): string | null {
  try {
    const b = Buffer.from(sealed, 'base64url');
    const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

/* ---------- stored connection ---------- */

interface Connection { tenantId: string; refreshToken: string }

async function loadConnection(db: Db, employeeId: string): Promise<Connection | null> {
  const r = (await db.query<{ tenant_id: string; refresh_token: string }>('SELECT tenant_id, refresh_token FROM calendar_connections WHERE employee_id=$1', [employeeId])).rows[0];
  if (!r) return null;
  const refreshToken = openSecret(r.refresh_token);
  if (!refreshToken) { await db.query('DELETE FROM calendar_connections WHERE employee_id=$1', [employeeId]); return null; } // key changed: reconnect
  return { tenantId: r.tenant_id, refreshToken };
}

async function saveConnection(db: Db, employeeId: string, tenantId: string, refreshToken: string) {
  await db.query(
    `INSERT INTO calendar_connections (employee_id, tenant_id, refresh_token) VALUES ($1,$2,$3)
     ON CONFLICT (employee_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, refresh_token=EXCLUDED.refresh_token, connected_at=now()`,
    [employeeId, tenantId, sealSecret(refreshToken)]);
}

/** An access token for this person; the rotated refresh token is stored right away. */
async function accessTokenFor(ctx: Ctx, employeeId: string): Promise<string> {
  const api = ctx.calendar!;
  const conn = await loadConnection(ctx.db, employeeId);
  if (!conn) throw new EntryError('Takvim bağlı değil. Önce “Takvimimi bağla”ya basın.', 409);
  try {
    const t = await api.refresh(conn);
    await ctx.db.query('UPDATE calendar_connections SET refresh_token=$2, last_used_at=now() WHERE employee_id=$1', [employeeId, sealSecret(t.refreshToken)]);
    return t.accessToken;
  } catch (e) {
    if (e instanceof InvalidGrant) {
      await ctx.db.query('DELETE FROM calendar_connections WHERE employee_id=$1', [employeeId]);
      throw new EntryError('Takvim bağlantınız sona erdi ya da izin geri alındı. “Takvimimi bağla” ile yeniden bağlayın.', 409);
    }
    throw e;
  }
}

/* ---------- meetings ---------- */

export interface Meeting {
  id: string; subject: string; date: string; start: string; end: string; hours: number; online: boolean;
  organizer: string | null; attendees: number; projectId: string | null; project: string | null; category: string; imported: boolean;
}

const hm = (s: string) => s.slice(11, 16);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export interface MyProject { id: string; name: string; customer: string | null }

async function myProjects(db: Db, u: User): Promise<MyProject[]> {
  return atLeast(u, 'PM')
    ? (await db.query<MyProject>(`SELECT id, name, customer FROM projects WHERE active ORDER BY name`)).rows
    : (await db.query<MyProject>(`SELECT p.id, p.name, p.customer FROM projects p JOIN employee_projects ep ON ep.project_id = p.id WHERE ep.employee_id=$1 AND p.active ORDER BY p.name`, [u.employeeId])).rows;
}

/** Words that say little about which project a meeting belongs to. */
const GENERIC = new Set(['proje', 'projesi', 'projeler', 'toplanti', 'toplantisi', 'ekibi', 'ekip', 'gorusme', 'gorusmesi', 'haftalik', 'gunluk', 'genel', 'sunum', 'planlama']);
const words = (s: string) => new Set(fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !GENERIC.has(t)));

/**
 * The project a meeting most likely belongs to: the title contains exactly one project name, or shares the most
 * distinctive words with exactly one project name ("Birch Strateji AI Projesi …" finds "Birch Strateji Ekibi YZ Asistanı").
 * One shared word is enough only when it is a long word that no other project name contains.
 */
export function guessProject(subject: string, projects: MyProject[]): MyProject | null {
  const whole = projects.filter((p) => p.name.trim().length >= 3 && fold(subject).includes(fold(p.name)));
  if (whole.length) return whole.length === 1 ? whole[0] : null;
  const sw = words(subject);
  const scored = projects.map((p) => ({ p, shared: [...words(p.name)].filter((t) => sw.has(t)) })).filter((x) => x.shared.length > 0);
  if (!scored.length) return null;
  const best = Math.max(...scored.map((x) => x.shared.length));
  const top = scored.filter((x) => x.shared.length === best);
  if (top.length !== 1) return null;
  if (best >= 2) return top[0].p;
  const w = top[0].shared[0];
  return w.length >= 5 && projects.filter((p) => words(p.name).has(w)).length === 1 ? top[0].p : null;
}

export async function listMeetings(ctx: Ctx, u: User, from: string, to: string): Promise<{ meetings: Meeting[]; skipped: number }> {
  const token = await accessTokenFor(ctx, u.employeeId);
  const events = await ctx.calendar!.events(token, `${from}T00:00:00+03:00`, `${addDays(to, 1)}T00:00:00+03:00`);
  const projects = await myProjects(ctx.db, u);
  const done = new Set((await ctx.db.query<{ external_ref: string }>(`SELECT external_ref FROM entries WHERE employee_id=$1 AND external_ref LIKE 'cal:%' AND NOT deleted`, [u.employeeId])).rows.map((r) => r.external_ref));
  let skipped = 0;
  const meetings: Meeting[] = [];
  for (const e of events) {
    const date = e.start.dateTime.slice(0, 10);
    const endDate = e.end.dateTime.slice(0, 10);
    const startMin = minutes(hm(e.start.dateTime));
    // A meeting that ends at midnight counts as ending at 24:00; anything longer than one day is not a meeting to log.
    const endMin = endDate === date ? minutes(hm(e.end.dateTime)) : endDate === addDays(date, 1) && hm(e.end.dateTime) === '00:00' ? 24 * 60 : -1;
    const free = ['free', 'workingElsewhere', 'oof'].includes(e.showAs);
    if (e.isCancelled || e.isAllDay || free || e.responseStatus?.response === 'declined' || endMin <= startMin || date < from || date > to) { skipped++; continue; }
    const subject = (e.subject ?? '').trim() || '(konusuz toplantı)';
    const p = guessProject(subject, projects);
    meetings.push({
      id: e.id, subject, date, start: hm(e.start.dateTime), end: endMin === 24 * 60 ? '23:59' : hm(e.end.dateTime), hours: Math.round(((endMin - startMin) / 60) * 100) / 100,
      online: !!e.isOnlineMeeting, organizer: e.organizer?.emailAddress?.name ?? null, attendees: (e.attendees ?? []).length,
      projectId: p?.id ?? null, project: p?.name ?? null, category: p ? 'Proje' : 'İç Operasyon', imported: done.has(`cal:${e.id}`),
    });
  }
  meetings.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return { meetings, skipped };
}

export async function importMeetings(ctx: Ctx, u: User, from: string, to: string, items: { id: string; projectId?: string | null; category?: string | null; description?: string | null; customer?: string | null }[]): Promise<{ created: number; skipped: number }> {
  // The server re-reads the meetings, so times and titles always come from the calendar and never from the browser.
  const { meetings } = await listMeetings(ctx, u, from, to);
  const projects = await myProjects(ctx.db, u);
  let created = 0; let skipped = 0;
  for (const it of items) {
    const m = meetings.find((x) => x.id === it.id);
    if (!m || m.imported) { skipped++; continue; }
    const project = it.projectId ? projects.find((p) => p.id === it.projectId) : null;
    if (it.projectId && !project) throw new EntryError('Bu proje size atanmamış', 403);
    const e = await createEntry(ctx, u.employeeId, u.dayHours, {
      date: m.date, start: m.start, end: m.end, description: it.description?.trim() ? it.description.trim().slice(0, 1000) : m.subject, projectId: project?.id ?? null,
      category: it.category ?? (project ? 'Proje' : 'İç Operasyon'),
      customer: it.customer?.trim() ? it.customer.trim() : (project?.customer ?? (project ? null : 'İç Çalışma')), workItem: project?.name ?? null,
    });
    try {
      await ctx.db.query(`UPDATE entries SET external_ref=$2, source='takvim', source_text=$3 WHERE id=$1`, [e.id, `cal:${m.id}`, m.subject]);
    } catch {
      await ctx.db.query(`UPDATE entries SET deleted=true WHERE id=$1`, [e.id]); // lost a race with another click: the other row stays
      skipped++; continue;
    }
    await confirmEntries(ctx.db, u.employeeId, [e.id]);
    created++;
  }
  if (created) await audit(ctx.db, u.employeeId, 'calendar_import', undefined, { created, from, to });
  return { created, skipped };
}

/* ---------- routes ---------- */

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { fn(req, res).catch(next); };
const isoDate = z.string().regex(/^\d{4}-\d\d-\d\d$/);
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const page = (res: Response, ok: boolean, msg: string) =>
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><title>Efor</title>${ok ? '<meta http-equiv="refresh" content="1;url=/#/hafta">' : ''}<body style="font-family:system-ui;max-width:480px;margin:60px auto"><p>${msg.replace(/[<>&"]/g, '')}</p><p><a href="/#/hafta">Efor’a dön</a></p></body>`);

/**
 * The Microsoft consent page returns to the same redirect URI as sign-in (`/auth/callback`), which is already
 * registered on the app, so nothing new has to be added there. The sign-in route hands the request over here when
 * it carries this person's calendar state cookie; anything else is a normal sign-in.
 */
export const calendarRedirectUri = () => `${config.PUBLIC_URL}/auth/callback`;

export async function handleCalendarCallback(ctx: Ctx, req: Request, res: Response): Promise<boolean> {
  const saved = openToken<{ verifier: string; state: string; tenantId: string; employeeId: string }>(parseCookies(req).efor_cal);
  if (!saved || req.query.state !== saved.state) return false;
  clearCookie(res, 'efor_cal');
  try {
    if (!req.user || !config.CALENDAR_ENABLED || !ctx.calendar) throw new Error('Oturum bulunamadı');
    if (typeof req.query.error === 'string') throw new Error(`İzin verilmedi: ${String(req.query.error_description ?? req.query.error).slice(0, 300)}`);
    if (saved.employeeId !== req.user.employeeId || typeof req.query.code !== 'string') throw new Error('Geçersiz bağlantı isteği');
    const t = await ctx.calendar.exchangeCode({ tenantId: saved.tenantId, code: req.query.code, verifier: saved.verifier, redirectUri: calendarRedirectUri() });
    // The account that consented has to be this person's account in that tenant.
    const idn = (await ctx.db.query<{ entra_oid: string | null }>(`SELECT entra_oid FROM identities WHERE employee_id=$1 AND tenant_id=$2`, [req.user.employeeId, saved.tenantId])).rows[0];
    if ((t.tid && t.tid.toLowerCase() !== saved.tenantId.toLowerCase()) || (t.oid && idn?.entra_oid && t.oid !== idn.entra_oid)) throw new Error('Takvim izni başka bir hesapla verildi. Efor’a giriş yaptığınız hesapla bağlayın.');
    await saveConnection(ctx.db, req.user.employeeId, saved.tenantId, t.refreshToken);
    await audit(ctx.db, req.user.employeeId, 'calendar_connect', saved.tenantId);
    page(res, true, 'Takvim bağlandı. Efor’a yönlendiriliyorsunuz…');
  } catch (e) {
    page(res, false, `Takvim bağlanamadı: ${(e as Error).message}`);
  }
  return true;
}

export function calendarRouter(ctx: Ctx): Router {
  const r = Router();
  const on = () => config.CALENDAR_ENABLED && !!ctx.calendar;
  const me = (req: Request) => req.user as User;
  const redirectUri = () => calendarRedirectUri();

  r.get('/api/calendar/status', requireUser, wrap(async (req, res) => {
    if (!on()) return void res.json({ enabled: false, connected: false });
    res.json({ enabled: true, connected: !!(await loadConnection(ctx.db, me(req).employeeId)) });
  }));

  r.get('/auth/calendar/connect', wrap(async (req, res) => {
    if (!req.user) return void res.redirect('/auth/login');
    if (!on()) return void page(res, false, 'Takvim bağlantısı bu ortamda açık değil.');
    // The identity (tenant) the person signs in with; a person with accounts in both tenants uses the one matching their e-mail.
    const id = (await ctx.db.query<{ tenant_id: string; email: string }>(
      `SELECT tenant_id, email FROM identities WHERE employee_id=$1 ORDER BY (lower(email)=lower($2)) DESC, tenant_id LIMIT 1`, [me(req).employeeId, me(req).email])).rows[0];
    if (!id) return void page(res, false, 'Hesabınız için bir kiracı bulunamadı.');
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    setCookie(res, 'efor_cal', sealToken({ verifier, state, tenantId: id.tenant_id, employeeId: me(req).employeeId }, 10 * 60 * 1000), 10 * 60 * 1000);
    res.redirect(ctx.calendar!.authorizeUrl({ tenantId: id.tenant_id, state, challenge: sha(verifier), loginHint: id.email, redirectUri: redirectUri() }));
  }));

  r.delete('/api/calendar', requireUser, wrap(async (req, res) => {
    await ctx.db.query('DELETE FROM calendar_connections WHERE employee_id=$1', [me(req).employeeId]);
    await audit(ctx.db, me(req).employeeId, 'calendar_disconnect');
    res.json({ ok: true });
  }));

  r.get('/api/calendar/meetings', requireUser, wrap(async (req, res) => {
    if (!on()) throw new EntryError('Takvim bağlantısı bu ortamda açık değil.', 404);
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    if (q.to < q.from || q.to > addDays(q.from, 31)) throw new EntryError('Tarih aralığı en fazla 31 gün olabilir.');
    res.json(await listMeetings(ctx, me(req), q.from, q.to));
  }));

  r.post('/api/calendar/import', requireUser, wrap(async (req, res) => {
    if (!on()) throw new EntryError('Takvim bağlantısı bu ortamda açık değil.', 404);
    const b = z.object({ from: isoDate, to: isoDate, items: z.array(z.object({ id: z.string().min(1).max(500), projectId: z.string().uuid().nullable().optional(), category: z.string().max(60).nullable().optional(), description: z.string().max(1000).nullable().optional(), customer: z.string().max(300).nullable().optional() })).min(1).max(100) }).parse(req.body);
    if (b.to < b.from || b.to > addDays(b.from, 31)) throw new EntryError('Tarih aralığı en fazla 31 gün olabilir.');
    res.json(await importMeetings(ctx, me(req), b.from, b.to, b.items));
  }));

  return r;
}
