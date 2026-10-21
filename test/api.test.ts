import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import type { Ai, ChatMsg } from '../src/server/ai.js';
import { buildApp } from '../src/server/app.js';
import { resolveEmployee } from '../src/server/auth.js';
import type { Ctx } from '../src/server/context.js';
import type { Db } from '../src/server/db.js';
import { syncTenant, type Graph } from '../src/server/graph.js';
import { runDueReports, runReminders } from '../src/server/scheduler.js';
import { unsupportedNumbers } from '../src/server/chat.js';
import type { Extraction } from '../src/core/types.js';

let db: Db;
let server: Server;
let base: string;
let scripted: (msgs: ChatMsg[]) => { content: string | null; toolCalls: { id: string; name: string; args: string }[] };
let extraction: Extraction = { rows: [], mappings: [], notes: [] };

const ai: Ai = {
  model: 'fake',
  extract: async () => extraction,
  pick: async () => ({}),
  chat: async (m) => scripted(m),
};

class Client {
  cookie = '';
  constructor(public name: string) {}
  async login(email: string, role?: string, tenant = 'tenant-a') {
    const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: this.name, role, tenant }) });
    this.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    expect(r.status).toBe(200);
    return this;
  }
  async call(method: string, path: string, body?: unknown) {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie: this.cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
  }
  async form(path: string, fields: Record<string, string>, file?: { name: string; data: Buffer }) {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    if (file) f.set('file', new Blob([file.data]), file.name);
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: this.cookie }, body: f });
    return { status: r.status, body: (await r.json()) as any };
  }
}

const graphFake = (tasksByPlan: Record<string, any[]>): Graph => ({
  async get(_t, path) {
    if (path.endsWith('/buckets')) return { value: [{ id: 'b1', name: 'Raporlama' }] };
    if (path.endsWith('/tasks')) return { value: tasksByPlan[path.split('/')[3]] ?? [] };
    return { title: 'Plan A' };
  },
});

beforeAll(async () => {
  db = await testDb();
  const ctx: Ctx = { db, ai, blob: { put: async () => {}, get: async () => Buffer.from('x') }, today: () => '2026-10-12' };
  server = buildApp(ctx, graphFake({})).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

let cansu: Client, ayse: Client, mehmet: Client, admin: Client;
let projectId: string;

describe('sign-in and tenants', () => {
  it('refuses a tenant that is not on the allowlist', async () => {
    await expect(resolveEmployee(db, { tid: 'evil-tenant', oid: 'o', email: 'x@evil.com', name: 'X', roles: ['Admin'] })).rejects.toThrow('erişim yok');
  });
  it('gives one employee for a person with accounts in both tenants (linked by an admin)', async () => {
    admin = await new Client('Ece').login('ece@alpha.example.com', 'Admin');
    cansu = await new Client('Cansu').login('cansu@alpha.example.com', 'PM');
    ayse = await new Client('Ayşe').login('ayse@alpha.example.com');
    mehmet = await new Client('Mehmet').login('mehmet@alpha.example.com');
    // Ayşe also has an Beta account; she signs in with it before anyone links the two.
    const second = await new Client('Ayşe Beta').login('ayse@beta.example.com', undefined, 'tenant-b');
    const before = (await ayse.call('GET', '/api/me')).body.employeeId;
    const other = (await second.call('GET', '/api/me')).body.employeeId;
    expect(before).not.toBe(other);
    expect((await admin.call('POST', `/api/employees/${before}/identities`, { tenantId: 'tenant-b', email: 'ayse@beta.example.com' })).status).toBe(200);
    // Her Beta effort now belongs to the one employee record.
    const merged = (await db.query(`SELECT count(*)::int AS n FROM identities WHERE employee_id=$1`, [before])).rows[0].n;
    expect(merged).toBe(2);
  });
  it('employees cannot reach admin or PM routes', async () => {
    expect((await ayse.call('GET', '/api/employees')).status).toBe(403);
    expect((await ayse.call('POST', '/api/admin/period', { closedBefore: '2026-01-01' })).status).toBe(403);
    expect((await new Client('x').call('GET', '/api/week')).status).toBe(401);
  });
});

describe('seeded people', () => {
  it('are matched by e-mail on first sign-in, keep their seeded role, and take the real display name', async () => {
    const { seedPeople } = await import('../src/server/seed.js');
    expect(await seedPeople(db)).toBe(11);
    expect(await seedPeople(db)).toBe(11); // idempotent
    const emre = (await db.query(`SELECT e.role, count(i.id)::int AS ids FROM employees e JOIN identities i ON i.employee_id = e.id WHERE e.email='emre.demir@alpha.example.com' GROUP BY e.role`)).rows[0];
    expect(emre).toEqual({ role: 'Admin', ids: 2 }); // one person, both tenants
    const before = (await db.query(`SELECT count(*)::int AS n FROM employees WHERE email='cansu.kaya@beta.example.com'`)).rows[0].n;
    expect(before).toBe(1);
    const dil = await new Client('Cansu Kaya (Entra)').login('cansu.kaya@beta.example.com', undefined, 'tenant-b');
    const me = (await dil.call('GET', '/api/me')).body;
    expect(me.role).toBe('PM'); // from the seed, no Entra app role needed yet
    expect(me.name).toBe('Cansu Kaya (Entra)');
    expect((await db.query(`SELECT count(*)::int AS n FROM employees WHERE email='cansu.kaya@beta.example.com'`)).rows[0].n).toBe(1);
  });
});

describe('projects and Planner', () => {
  it('Cansu creates a project from a plan and assigns people; tasks sync in', async () => {
    const created = await cansu.call('POST', '/api/projects', { name: 'Lisans', customer: 'Acme', plans: [{ tenantId: 'tenant-a', planId: 'plan1', title: 'Plan A' }] });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    const ids = (await db.query(`SELECT id FROM employees WHERE email IN ('ayse@alpha.example.com','mehmet@alpha.example.com')`)).rows.map((r) => r.id);
    expect((await cansu.call('PUT', `/api/projects/${projectId}/members`, { employeeIds: ids })).status).toBe(200);
    const aoid = (await db.query(`SELECT entra_oid FROM identities WHERE email='ayse@alpha.example.com'`)).rows[0].entra_oid;
    const res = await syncTenant(db, graphFake({ plan1: [{ id: 't-rapor', title: 'Lisans raporu', bucketId: 'b1', assignments: { [aoid]: {} }, percentComplete: 0 }, { id: 't-uat', title: 'UAT', bucketId: 'b1', assignments: {}, percentComplete: 0 }] }), 'tenant-a');
    expect(res).toMatchObject({ plans: 1, tasks: 2, removed: 0 });
    // A task that disappears from the plan leaves the cache.
    expect((await syncTenant(db, graphFake({ plan1: [{ id: 't-rapor', title: 'Lisans raporu', bucketId: 'b1', assignments: { [aoid]: {} }, percentComplete: 0 }] }), 'tenant-a')).removed).toBe(1);
  });
  it('a project only appears to people assigned to it', async () => {
    const outsider = await new Client('Z').login('z@alpha.example.com');
    expect((await outsider.call('GET', '/api/projects')).body).toHaveLength(0);
    expect((await ayse.call('GET', '/api/projects')).body).toHaveLength(1);
    const up = await outsider.form('/api/uploads', { projectId }, { name: 'a.txt', data: Buffer.from('x') });
    expect(up.status).toBe(403);
  });
});

describe('upload → review → confirm over HTTP', () => {
  it('end to end, with the permission rules', async () => {
    extraction = {
      mappings: [], notes: [],
      rows: [{ date: 'pzt', time: null, effort: '3s', description: 'lisans raporu', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L1', source_text: 'pzt lisans raporu 3s' }],
    };
    const up = await ayse.form('/api/uploads', {}, { name: 'ayse_hafta41.txt', data: Buffer.from('pzt lisans raporu 3s') });
    expect(up.status).toBe(201);
    const detail = (await ayse.call('GET', `/api/uploads/${up.body.uploadId}`)).body;
    expect(detail.rows[0]).toMatchObject({ work_date: '2026-10-05', hours: 3, link_id: 't-rapor', status: 'draft' });
    // Another employee cannot read, confirm or discard it.
    expect((await mehmet.call('GET', `/api/uploads/${up.body.uploadId}`)).status).toBe(404);
    expect((await mehmet.call('POST', `/api/uploads/${up.body.uploadId}/confirm`)).status).toBe(409);
    expect((await ayse.form('/api/uploads', {}, { name: 'again.txt', data: Buffer.from('pzt lisans raporu 3s') })).status).toBe(409);
    expect((await ayse.call('POST', `/api/uploads/${up.body.uploadId}/confirm`)).body.confirmed).toBe(1);
  });
  it('rejects unsupported file types and bad input', async () => {
    expect((await ayse.form('/api/uploads', {}, { name: 'x.exe', data: Buffer.from('x') })).status).toBe(400);
    expect((await ayse.call('POST', '/api/entries', { date: 'şu an', hours: '3s' })).status).toBe(400);
  });
});

describe('manual entries and closed periods', () => {
  it('saves a manual entry, edits it, and refuses edits in a closed period', async () => {
    const e = (await ayse.call('POST', '/api/entries', { date: '6 Ekim', hours: '2,5 saat', description: 'elle', projectId })).body;
    expect(e).toMatchObject({ hours: 2.5, status: 'confirmed', saved: true });
    expect((await ayse.call('PATCH', `/api/entries/${e.id}`, { hours: 3 })).body.hours).toBe(3);
    expect((await mehmet.call('PATCH', `/api/entries/${e.id}`, { hours: 9 })).status).toBe(404);
    await admin.call('POST', '/api/admin/period', { closedBefore: '2026-10-07' });
    expect((await ayse.call('PATCH', `/api/entries/${e.id}`, { hours: 4 })).status).toBe(409);
    expect((await ayse.call('DELETE', `/api/entries/${e.id}`)).status).toBe(409);
    // New entries before the cut-off are flagged and not saved.
    const old = (await ayse.call('POST', '/api/entries', { date: '5 Ekim', hours: 1, description: 'eski' })).body;
    expect(old.saved).toBe(false);
    expect(old.flags).toContain('closed_period');
    await db.query('DELETE FROM periods');
  });
});

describe('reports honour permissions and agree with the data', () => {
  it('employee sees own effort only; PM sees her projects; totals match', async () => {
    await mehmet.call('POST', '/api/entries', { date: '7 Ekim', hours: 5, description: 'm', projectId });
    const mine = (await ayse.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-31', groupBy: ['person'] } })).body;
    expect(mine.rows.map((r: any) => r.g0)).toEqual(['Ayşe']);
    const team = (await cansu.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-31', groupBy: ['person'] } })).body;
    expect(team.rows.map((r: any) => r.g0).sort()).toEqual(['Ayşe', 'Mehmet']);
    expect(team.total).toBeCloseTo(mine.total + 5, 5);
    expect((await ayse.call('POST', '/api/reports/run', { preset: 'project-tasks' })).status).toBe(403);
    expect((await ayse.call('POST', '/api/reports/run', { definition: { kind: 'missing_days', from: '2026-10-05', to: '2026-10-09' } })).status).toBe(403);
  });
  it('a PM also sees the other work of the people on her projects, but not people outside them', async () => {
    await mehmet.call('POST', '/api/entries', { date: '1 Ekim', hours: 2, description: 'projesiz iş' }); // Mehmet is on Cansu's project; this entry has none
    const team = (await cansu.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-01', groupBy: ['person'] } })).body;
    expect(team.rows.map((r: any) => r.g0)).toContain('Mehmet');
    const alone = (await ayse.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-01', groupBy: ['person'] } })).body;
    expect(alone.rows.map((r: any) => r.g0)).not.toContain('Mehmet');
  });
  it('a PM also sees the other work of the people on her projects, but not people outside them', async () => {
    await mehmet.call('POST', '/api/entries', { date: '1 Ekim', hours: 2, description: 'projesiz iş' }); // Mehmet is on Cansu's project; this entry has none
    const team = (await cansu.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-01', groupBy: ['person'] } })).body;
    expect(team.rows.map((r: any) => r.g0)).toContain('Mehmet');
    const alone = (await ayse.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-01', groupBy: ['person'] } })).body;
    expect(alone.rows.map((r: any) => r.g0)).not.toContain('Mehmet');
  });
  it('exports Excel with a live SUM and a non-empty PDF', async () => {
    const q = encodeURIComponent(JSON.stringify({ preset: 'project-people-weeks', from: '2026-10-01', to: '2026-10-31' }));
    const x = await cansu.call('GET', `/api/reports/export?format=xlsx&q=${q}`);
    expect(x.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Rapor')!;
    const last = ws.getRow(ws.rowCount);
    expect(String(last.getCell(1).value)).toBe('Toplam');
    expect(JSON.stringify(last.values)).toContain('SUM(');
    const p = await cansu.call('GET', `/api/reports/export?format=pdf&q=${q}`);
    expect(p.status).toBe(200);
    expect((p.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
  it('missing-days report lists people without effort, for PM and admin only', async () => {
    const r = (await cansu.call('POST', '/api/reports/run', { definition: { kind: 'missing_days', from: '2026-10-05', to: '2026-10-09' } })).body;
    const names = r.rows.map((x: any) => x.person);
    expect(names).toContain('Mehmet');
    expect(r.rows.find((x: any) => x.person === 'Mehmet').missing).toBe(4);
  });
});

describe('chat', () => {
  const call = (name: string, args: object, id = 'c1') => ({ content: null, toolCalls: [{ id, name, args: JSON.stringify(args) }] });

  it('answers from tool results and attaches the report card', async () => {
    let step = 0;
    scripted = (msgs) => {
      if (step++ === 0) return call('my_effort', { from: '2026-10-01', to: '2026-10-31', group_by: ['project'], link_kind: null });
      const tool = msgs.filter((m) => m.role === 'tool').pop()!.content!;
      const total = JSON.parse(tool).toplam_saat;
      return { content: `Ekim ayında toplam ${total} saat girdiniz.`, toolCalls: [] };
    };
    const r = await ayse.form('/api/chat', { message: 'ekimde ne kadar çalıştım?' });
    expect(r.body.reply).toBe('Ekim ayında toplam 6 saat girdiniz.');
    const report = (await ayse.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-31', groupBy: [], filters: { employeeIds: [(await ayse.call('GET', '/api/me')).body.employeeId] } } })).body;
    expect(report.total).toBe(6); // the chat and the report page agree
    expect(r.body.cards[0]).toMatchObject({ type: 'report', total: 6 });
  });

  it('replaces a reply that contains an invented number', async () => {
    scripted = () => ({ content: 'Toplam 99 saat girdiniz.', toolCalls: [] });
    const r = await ayse.form('/api/chat', { message: 'toplamım?' });
    expect(r.body.reply).not.toContain('99');
  });

  it('a chat sentence only proposes rows; nothing is saved until the person clicks', async () => {
    extraction = { mappings: [], notes: [], rows: [{ date: 'bugün', time: null, effort: '3 saat', description: 'switch kurulumu', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L1', source_text: 'bugün 3 saat switch kurulumu' }] };
    let step = 0;
    scripted = () => (step++ === 0 ? call('add_entries', { text: 'bugün 3 saat switch kurulumu' }) : { content: 'Taslak hazır, onaylayın.', toolCalls: [] });
    const before = (await db.query(`SELECT count(*)::int AS n FROM entries WHERE status<>'draft'`)).rows[0].n;
    const r = await ayse.form('/api/chat', { message: 'bugün 3 saat switch kurulumu' });
    expect(r.body.cards[0]).toMatchObject({ type: 'draft', total: 3, blocked: 0 });
    expect((await db.query(`SELECT count(*)::int AS n FROM entries WHERE status<>'draft'`)).rows[0].n).toBe(before);
    expect((await ayse.call('POST', `/api/uploads/${r.body.cards[0].uploadId}/confirm`)).body.confirmed).toBe(1);
  });

  it('an edit is a pending action: the model cannot apply it, only the click can', async () => {
    const entry = (await db.query(`SELECT e.id FROM entries e JOIN employees p ON p.id = e.employee_id WHERE p.email='ayse@alpha.example.com' AND e.description='switch kurulumu'`)).rows[0].id;
    let step = 0;
    scripted = () => (step++ === 0 ? call('edit_entry', { entry_id: entry, date: null, hours: '4 saat', description: null, link_id: null }) : { content: 'Öneriyi hazırladım.', toolCalls: [] });
    const r = await ayse.form('/api/chat', { message: 'switch kurulumu 4 saatti' });
    expect((await db.query(`SELECT hours FROM entries WHERE id=$1`, [entry])).rows[0].hours).toBe(3);
    const action = r.body.cards.find((c: any) => c.type === 'pending');
    expect((await mehmet.call('POST', `/api/pending/${action.actionId}/apply`)).status).toBe(404);
    expect((await ayse.call('POST', `/api/pending/${action.actionId}/apply`)).status).toBe(200);
    expect((await db.query(`SELECT hours FROM entries WHERE id=$1`, [entry])).rows[0].hours).toBe(4);
    expect((await ayse.call('POST', `/api/pending/${action.actionId}/apply`)).status).toBe(409);
  });

  it('cannot touch another person\'s rows through the tools', async () => {
    const theirs = (await db.query(`SELECT e.id FROM entries e JOIN employees p ON p.id=e.employee_id WHERE p.email='mehmet@alpha.example.com' LIMIT 1`)).rows[0].id;
    let step = 0;
    let toolText = '';
    scripted = (msgs) => {
      if (step++ === 0) return call('delete_entry', { entry_id: theirs });
      toolText = msgs.filter((m) => m.role === 'tool').pop()!.content!;
      return { content: 'Bulamadım.', toolCalls: [] };
    };
    await ayse.form('/api/chat', { message: 'Mehmet\'in kaydını sil' });
    expect(toolText).toContain('bulunamadı');
  });

  it('a file dropped in the chat shows the rows without any model call for the reply', async () => {
    extraction = { mappings: [], notes: [], rows: [{ date: 'salı', time: null, effort: '2 saat', description: 'x', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L1', source_text: 'salı x 2 saat' }] };
    scripted = () => { throw new Error('model must not be called'); };
    const r = await ayse.form('/api/chat', { message: '' }, { name: 'hafta41.txt', data: Buffer.from('salı x 2 saat') });
    expect(r.status).toBe(200);
    expect(r.body.cards[0]).toMatchObject({ type: 'draft', total: 2 });
  });
});

describe('number guard', () => {
  it('lets through numbers from sources and dates, blocks the rest', () => {
    expect(unsupportedNumbers('Toplam 6,5 saat, 12 Ekim', ['{"toplam_saat":6.5}', 'ekimde 12'])).toEqual([]);
    expect(unsupportedNumbers('Toplam 7 saat', ['{"toplam_saat":6.5}'])).toEqual(['7']);
  });
});

describe('scheduled reports and reminders', () => {
  const sent: { to: string[]; subject: string; att: number }[] = [];
  const mail = { send: async (to: string[], subject: string, _t: string, a?: unknown[]) => { sent.push({ to, subject, att: a?.length ?? 0 }); } };

  it('mails the previous month on the scheduled day, once', async () => {
    await cansu.call('POST', '/api/reports/saved', { name: 'Aylık müşteri', definition: { from: '2026-01-01', to: '2026-01-31', groupBy: ['customer'] }, schedule: { kind: 'monthly', day: 1, hour: 8, recipients: ['cansu@alpha.example.com'] } });
    expect((await ayse.call('POST', '/api/reports/saved', { name: 'x', definition: { from: '2026-01-01', to: '2026-01-31' }, schedule: { kind: 'monthly', day: 1, hour: 8, recipients: ['a@b.com'] } })).status).toBe(403);
    expect(await runDueReports(db, mail, { date: '2026-10-02', hour: 9, weekday: 5 })).toBe(0);
    expect(await runDueReports(db, mail, { date: '2026-11-01', hour: 7, weekday: 7 })).toBe(0);
    expect(await runDueReports(db, mail, { date: '2026-11-01', hour: 9, weekday: 7 })).toBe(1);
    expect(sent[0].subject).toContain('2026-10-01 – 2026-10-31');
    expect(sent[0].att).toBe(1);
    expect(await runDueReports(db, mail, { date: '2026-11-01', hour: 10, weekday: 7 })).toBe(0);
  });

  it('reminds only people with missing days, on Friday afternoon, once', async () => {
    sent.length = 0;
    expect(await runReminders(db, mail, { date: '2026-10-08', hour: 16, weekday: 4 })).toBe(0);
    expect(await runReminders(db, mail, { date: '2026-10-09', hour: 14, weekday: 5 })).toBe(0);
    const n = await runReminders(db, mail, { date: '2026-10-09', hour: 16, weekday: 5 });
    expect(n).toBeGreaterThan(0);
    expect(sent.some((s) => s.to[0] === 'mehmet@alpha.example.com')).toBe(true);
    expect(await runReminders(db, mail, { date: '2026-10-09', hour: 17, weekday: 5 })).toBe(0);
  });
});

describe('edit a project, and attach a file to a project in the assistant', () => {
  it('the creator edits name, customer and code; others cannot; an empty name is refused', async () => {
    const r = await cansu.call('PATCH', `/api/projects/${projectId}`, { name: '  Lisans   Yönetimi ', customer: 'Yeni Edit Müşterisi', code: ' LY-1 ' });
    expect(r.status).toBe(200);
    const row = (await db.query(`SELECT name, customer, code FROM projects WHERE id=$1`, [projectId])).rows[0];
    expect(row).toEqual({ name: 'Lisans Yönetimi', customer: 'Yeni Edit Müşterisi', code: 'LY-1' });
    // A customer typed on the edit form is remembered for everyone, like everywhere else.
    expect((await db.query(`SELECT 1 FROM customers WHERE name='Yeni Edit Müşterisi'`)).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM audit_events WHERE action='project_update' AND target=$1`, [projectId])).rows).toHaveLength(1);
    expect((await ayse.call('PATCH', `/api/projects/${projectId}`, { name: 'Hack' })).status).toBe(403); // not a PM
    const otherPm = await new Client('Başka PM').login('baska.pm@alpha.example.com', 'PM');
    expect((await otherPm.call('PATCH', `/api/projects/${projectId}`, { name: 'Hack' })).status).toBe(403); // a PM, but not the creator
    expect((await admin.call('PATCH', `/api/projects/${projectId}`, { code: null })).status).toBe(200); // admins may
    expect((await cansu.call('PATCH', `/api/projects/${projectId}`, { name: '   ' })).status).toBe(400);
    expect((await cansu.call('PATCH', `/api/projects/00000000-0000-4000-8000-000000000000`, { name: 'x' })).status).toBe(404);
    expect((await db.query(`SELECT name, code FROM projects WHERE id=$1`, [projectId])).rows[0]).toEqual({ name: 'Lisans Yönetimi', code: null });
  });

  it('a file attached in the chat with a project links every row to it; a project the person is not on is refused', async () => {
    extraction = { mappings: [], notes: [], rows: [{ date: 'çarşamba', time: null, effort: '2 saat', description: 'rapor', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L1', source_text: 'çarşamba rapor 2 saat' }] };
    scripted = () => { throw new Error('model must not be called'); };
    const r = await ayse.form('/api/chat', { message: '', projectId }, { name: 'proje-dosyasi-1.txt', data: Buffer.from('çarşamba rapor 2 saat proje') });
    expect(r.status).toBe(200);
    expect(r.body.reply).toContain('Lisans Yönetimi');
    const rows = (await db.query(`SELECT project_id FROM entries WHERE upload_id=$1`, [r.body.cards[0].uploadId])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.project_id === projectId)).toBe(true);
    const lonely = (await cansu.call('POST', '/api/projects', { name: 'Kimsenin Projesi' })).body.id;
    const refused = await ayse.form('/api/chat', { message: '', projectId: lonely }, { name: 'proje-dosyasi-2.txt', data: Buffer.from('çarşamba rapor 2 saat başka') });
    expect(refused.status).toBe(403);
  });
});

describe('editing a saved row', () => {
  it('changes name, customer, category, project and times, and only onto a project the person is on', async () => {
    const made = await ayse.call('POST', '/api/entries', { date: '2026-10-07', hours: 2, description: 'Toplantı', category: 'İç Operasyon', customer: 'İç Çalışma' });
    expect(made.status).toBe(201);
    const id = made.body.id;
    const r = await ayse.call('PATCH', `/api/entries/${id}`, { description: 'Müşteri toplantısı: kapsam', category: 'Proje', customer: 'Acme', projectId, workItem: 'Lisans Yönetimi', product: 'Microsoft 365', date: '2026-10-08', start: '10:00', end: '11:30', hours: 1.5 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ description: 'Müşteri toplantısı: kapsam', category: 'Proje', customer: 'Acme', project_id: projectId, work_item: 'Lisans Yönetimi', product: 'Microsoft 365', work_date: '2026-10-08', hours: 1.5, status: 'confirmed' });
    const elsewhere = (await cansu.call('POST', '/api/projects', { name: 'Başkasının Projesi' })).body.id;
    expect((await ayse.call('PATCH', `/api/entries/${id}`, { projectId: elsewhere })).status).toBe(403);
    expect((await ayse.call('POST', '/api/entries', { date: '2026-10-07', hours: 1, projectId: elsewhere })).status).toBe(403);
    expect((await mehmet.call('PATCH', `/api/entries/${id}`, { description: 'Hack' })).status).toBe(404); // someone else's row
    expect((await ayse.call('PATCH', `/api/entries/${id}`, { projectId: null })).body.project_id).toBeNull(); // taking it off a project is always fine
  });
});

