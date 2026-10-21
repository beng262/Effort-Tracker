import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import { buildApp } from '../src/server/app.js';
import { InvalidGrant, openSecret, sealSecret, type CalendarApi, type GraphEvent } from '../src/server/calendar.js';

const ev = (id: string, subject: string | null, start: string, end: string, extra: Partial<GraphEvent> = {}): GraphEvent =>
  ({ id, subject, isAllDay: false, isCancelled: false, showAs: 'busy', start: { dateTime: `${start}.0000000` }, end: { dateTime: `${end}.0000000` }, ...extra });

describe('calendar meetings as effort', () => {
  let server: Server; let base: string; let db: any;
  let events: GraphEvent[] = [];
  let refreshCalls = 0; let nextRefresh = 'rt-2'; let failRefresh = false;
  const fake: CalendarApi = {
    authorizeUrl: ({ state, loginHint }) => `https://login.example/authorize?state=${state}&login_hint=${encodeURIComponent(loginHint)}`,
    exchangeCode: async ({ code }) => (code === 'bad-account'
      ? { refreshToken: 'rt-x', accessToken: 'at', tid: 'tenant-b', oid: 'someone-else' }
      : { refreshToken: 'rt-1', accessToken: 'at', tid: 'tenant-a', oid: 'dev-ayse@x.com' }),
    refresh: async () => { refreshCalls++; if (failRefresh) throw new InvalidGrant('revoked'); return { accessToken: `at-${refreshCalls}`, refreshToken: nextRefresh }; },
    events: async () => events,
  };

  class Person {
    cookie = '';
    constructor(public email: string, public name: string, public role = 'Employee') {}
    async login() {
      const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email, name: this.name, role: this.role, tenant: 'tenant-a' }) });
      this.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
      return this;
    }
    call(method: string, path: string, body?: unknown, extraCookie = '') {
      return fetch(`${base}${path}`, { method, redirect: 'manual', headers: { cookie: [this.cookie, extraCookie].filter(Boolean).join('; '), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    }
    async connect() {
      const r = await this.call('GET', '/auth/calendar/connect');
      const state = new URL(r.headers.get('location')!).searchParams.get('state')!;
      const calCookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
      return { r, state, calCookie };
    }
  }
  let ayse: Person; let mehmet: Person; let projectId: string; let otherProject: string;

  beforeAll(async () => {
    db = await testDb();
    server = buildApp({ db, ai: {} as any, blob: {} as any, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, calendar: fake, today: () => '2026-10-21' } as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ayse = await new Person('ayse@x.com', 'Ayşe').login();
    mehmet = await new Person('mehmet@x.com', 'Mehmet').login();
    const ae = (await db.query(`SELECT id FROM employees WHERE email='ayse@x.com'`)).rows[0].id;
    projectId = (await db.query(`INSERT INTO projects (name, customer, created_by) VALUES ('Lisans Yönetimi','Acme',$1) RETURNING id`, [ae])).rows[0].id;
    otherProject = (await db.query(`INSERT INTO projects (name, created_by) VALUES ('Gizli Proje',$1) RETURNING id`, [ae])).rows[0].id;
    await db.query(`INSERT INTO employee_projects VALUES ($1,$2)`, [ae, projectId]);
  });
  afterAll(() => { server.close(); });

  it('seals the refresh token: the stored value is not the token, and only this app can open it', () => {
    const sealed = sealSecret('refresh-secret');
    expect(sealed).not.toContain('refresh-secret');
    expect(openSecret(sealed)).toBe('refresh-secret');
    expect(openSecret(sealed.slice(0, -4) + 'AAAA')).toBeNull();
  });

  it('starts disconnected, connects through the consent page, and stores only a sealed token', async () => {
    expect(await (await ayse.call('GET', '/api/calendar/status')).json()).toEqual({ enabled: true, connected: false });
    const { r, state, calCookie } = await ayse.connect();
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get('location')!).searchParams.get('login_hint')).toBe('ayse@x.com');
    // a wrong state is refused and stores nothing
    const bad = await ayse.call('GET', `/auth/calendar/callback?code=c&state=wrong`, undefined, calCookie);
    expect(bad.status).toBe(400);
    expect((await db.query('SELECT 1 FROM calendar_connections')).rows).toHaveLength(0);
    // the account that consented must be the signed-in person
    const other = await ayse.connect();
    expect((await ayse.call('GET', `/auth/calendar/callback?code=bad-account&state=${other.state}`, undefined, other.calCookie)).status).toBe(400);
    expect((await db.query('SELECT 1 FROM calendar_connections')).rows).toHaveLength(0);
    // the real thing
    const ok = await ayse.connect();
    const done = await ayse.call('GET', `/auth/calendar/callback?code=good&state=${ok.state}`, undefined, ok.calCookie);
    expect(done.status).toBe(200);
    const row = (await db.query('SELECT tenant_id, refresh_token FROM calendar_connections')).rows[0];
    expect(row.tenant_id).toBe('tenant-a');
    expect(row.refresh_token).not.toContain('rt-1');
    expect(openSecret(row.refresh_token)).toBe('rt-1');
    expect(await (await ayse.call('GET', '/api/calendar/status')).json()).toEqual({ enabled: true, connected: true });
    expect(await (await mehmet.call('GET', '/api/calendar/status')).json()).toEqual({ enabled: true, connected: false }); // per person
    expect((await db.query(`SELECT 1 FROM audit_events WHERE action='calendar_connect'`)).rows).toHaveLength(1);
  });

  it('lists the meetings worth logging and drops the rest', async () => {
    events = [
      ev('e1', 'Lisans Yönetimi haftalık toplantı', '2026-10-19T10:00:00', '2026-10-19T11:00:00', { isOnlineMeeting: true, attendees: [{}, {}] }),
      ev('e2', 'Ekip toplantısı', '2026-10-20T14:00:00', '2026-10-20T15:30:00'),
      ev('e3', 'Doğum günü', '2026-10-20T00:00:00', '2026-10-21T00:00:00', { isAllDay: true }),
      ev('e4', 'İptal edilen', '2026-10-20T09:00:00', '2026-10-20T10:00:00', { isCancelled: true }),
      ev('e5', 'Reddettiğim', '2026-10-20T11:00:00', '2026-10-20T12:00:00', { responseStatus: { response: 'declined' } }),
      ev('e6', 'Boşta işaretli', '2026-10-20T16:00:00', '2026-10-20T17:00:00', { showAs: 'free' }),
      ev('e7', 'Çok günlü', '2026-10-20T16:00:00', '2026-10-22T10:00:00'),
      ev('e8', null, '2026-10-21T09:00:00', '2026-10-21T09:30:00'),
    ];
    refreshCalls = 0; nextRefresh = 'rt-2';
    const r = await (await ayse.call('GET', '/api/calendar/meetings?from=2026-10-19&to=2026-10-21')).json();
    expect(r.meetings.map((m: any) => m.id)).toEqual(['e1', 'e2', 'e8']);
    expect(r.skipped).toBe(5);
    expect(r.meetings[0]).toMatchObject({ date: '2026-10-19', start: '10:00', end: '11:00', hours: 1, online: true, attendees: 2, project: 'Lisans Yönetimi', category: 'Proje', imported: false });
    expect(r.meetings[1]).toMatchObject({ hours: 1.5, project: null, category: 'İç Operasyon' });
    expect(r.meetings[2].subject).toBe('(konusuz toplantı)');
    // the rotated refresh token replaced the old one
    expect(openSecret((await db.query('SELECT refresh_token FROM calendar_connections')).rows[0].refresh_token)).toBe('rt-2');
    expect((await mehmet.call('GET', '/api/calendar/meetings?from=2026-10-19&to=2026-10-21')).status).toBe(409); // not connected
    expect((await ayse.call('GET', '/api/calendar/meetings?from=2026-10-19&to=2026-12-31')).status).toBe(400);
  });

  it('adds only the ticked meetings, with the times from the calendar, and never twice', async () => {
    const body = { from: '2026-10-19', to: '2026-10-21', items: [{ id: 'e1', projectId }, { id: 'e2' }] };
    const r = await (await ayse.call('POST', '/api/calendar/import', body)).json();
    expect(r).toEqual({ created: 2, skipped: 0 });
    const rows = (await db.query(`SELECT description, work_date::text AS d, hours::float AS h, start_time::text AS s, status, project_id, category, external_ref FROM entries WHERE NOT deleted ORDER BY work_date`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ description: 'Lisans Yönetimi haftalık toplantı', d: '2026-10-19', h: 1, s: '10:00:00', status: 'confirmed', project_id: projectId, category: 'Proje', external_ref: 'cal:e1' });
    expect(rows[1]).toMatchObject({ description: 'Ekip toplantısı', h: 1.5, status: 'confirmed', project_id: null, category: 'İç Operasyon', external_ref: 'cal:e2' });
    // the list now shows them as added, and a second import adds nothing
    const again = await (await ayse.call('GET', '/api/calendar/meetings?from=2026-10-19&to=2026-10-21')).json();
    expect(again.meetings.filter((m: any) => m.imported).map((m: any) => m.id)).toEqual(['e1', 'e2']);
    expect(await (await ayse.call('POST', '/api/calendar/import', body)).json()).toEqual({ created: 0, skipped: 2 });
    // deleting a row frees the meeting to be added again
    await db.query(`UPDATE entries SET deleted=true WHERE external_ref='cal:e2'`);
    expect(await (await ayse.call('POST', '/api/calendar/import', { ...body, items: [{ id: 'e2' }] })).json()).toEqual({ created: 1, skipped: 0 });
  });

  it('refuses a project the person is not on, and an id that is not in the calendar', async () => {
    expect((await ayse.call('POST', '/api/calendar/import', { from: '2026-10-19', to: '2026-10-21', items: [{ id: 'e8', projectId: otherProject }] })).status).toBe(403);
    expect(await (await ayse.call('POST', '/api/calendar/import', { from: '2026-10-19', to: '2026-10-21', items: [{ id: 'nope' }] })).json()).toEqual({ created: 0, skipped: 1 });
  });

  it('forgets a connection whose permission was revoked, and disconnects on request', async () => {
    failRefresh = true;
    const r = await ayse.call('GET', '/api/calendar/meetings?from=2026-10-19&to=2026-10-21');
    expect(r.status).toBe(409);
    expect((await db.query('SELECT 1 FROM calendar_connections')).rows).toHaveLength(0);
    failRefresh = false;
    const c = await ayse.connect();
    await ayse.call('GET', `/auth/calendar/callback?code=good&state=${c.state}`, undefined, c.calCookie);
    expect((await db.query('SELECT 1 FROM calendar_connections')).rows).toHaveLength(1);
    expect((await ayse.call('DELETE', '/api/calendar')).status).toBe(200);
    expect((await db.query('SELECT 1 FROM calendar_connections')).rows).toHaveLength(0);
  });

  it('does nothing for someone who is not signed in', async () => {
    const r = await fetch(`${base}/api/calendar/status`);
    expect(r.status).toBe(401);
    expect((await fetch(`${base}/auth/calendar/connect`, { redirect: 'manual' })).status).toBe(302);
  });
});
