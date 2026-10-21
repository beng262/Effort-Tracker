import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import type { Ai, PlanEditProposal } from '../src/server/ai.js';
import { buildApp } from '../src/server/app.js';
import type { Ctx } from '../src/server/context.js';
import type { Db } from '../src/server/db.js';
import { preRead } from '../src/core/grid.js';
import { parsePlanSheet, validateEdits, normalizeStatus, type PlanTask } from '../src/core/plan.js';
import type { Extraction } from '../src/core/types.js';

/** A workbook shaped like a real project tracker: a catalog sheet that must be ignored, and a plan sheet whose header is shifted against the data. */
async function trackerWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const cat = wb.addWorksheet('Ajan Kataloğu');
  cat.addRow(['ID', 'Ajan Adı', 'Durum']);
  cat.addRow(['A01', 'Infrastructure Health Agent', 'Planlandı']);
  const ws = wb.addWorksheet('Proje Planı');
  ws.addRow(['Proje Planı & Backlog (Dalgalı)']);
  ws.addRow([]);
  ws.addRow(['ID', 'Dalga / Faz', 'İş Paketi / Görev', 'Sahip', 'Bağımlılık', 'Hedef Tarih', 'Durum']);
  const sect = (t: string) => { const r = ws.addRow([t, t, t, t, t, t, t]); r.commit(); };
  sect('Dalga 0 — Temel & Yönetişim (Ağu 2026)');
  ws.addRow(['W0.1', 'Agent 365 kiracı kurulumu', 'Mesut', '-', '2026-08-08', 'Planlandı']);
  ws.addRow(['W0.2', 'Defender + Purview kuralları', 'Burak', 'W0.1', '2026-08-15', 'Devam']);
  sect('Dalga 1 — İzleme MVP (Eyl 2026)');
  ws.addRow(['W1.1', 'A01 Infrastructure Health Agent', 'Burak', 'W0.4', '2026-09-09', 'Tamamlandı']);
  ws.addRow(['W1.4', 'A04 Service Desk Controller Agent', 'Mesut', 'W0.5', '2026-09-23', 'Planlandı']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('plan parser', () => {
  it('reads tasks with dates, owners, dependencies and sections, and ignores the catalog sheet', async () => {
    const pre = await preRead('IT_Ajan_Projesi_Takip.xlsx', await trackerWorkbook());
    const { tasks } = parsePlanSheet(pre, 2026);
    expect(tasks.map((t) => t.extId)).toEqual(['W0.1', 'W0.2', 'W1.1', 'W1.4']);
    expect(tasks[0]).toMatchObject({ section: 'Dalga 0 — Temel & Yönetişim (Ağu 2026)', title: 'Agent 365 kiracı kurulumu', owner: 'Mesut', dependsOn: null, dueDate: '2026-08-08', status: 'Planlandı' });
    expect(tasks[1]).toMatchObject({ dependsOn: 'W0.1', status: 'Devam' });
    expect(tasks[2]).toMatchObject({ section: 'Dalga 1 — İzleme MVP (Eyl 2026)', status: 'Tamamlandı', dueDate: '2026-09-09' });
  });
  it('finds nothing in a file that has no plan, and says so', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Efor').addRow(['Tarih', 'Saat']);
    const { tasks, notes } = parsePlanSheet(await preRead('x.xlsx', Buffer.from(await wb.xlsx.writeBuffer())), 2026);
    expect(tasks).toHaveLength(0);
    expect(notes[0]).toContain('bulunamadı');
  });
  it('normalises Turkish and English status words', () => {
    expect(normalizeStatus('devam ediyor')).toBe('Devam');
    expect(normalizeStatus('BİTTİ')).toBe('Tamamlandı');
    expect(normalizeStatus('blocked')).toBe('Bloke');
    expect(normalizeStatus('belki')).toBeNull();
  });
});


/** The real "Birch Strateji YZ Asistanı" layout: numeric ids, a Tip column with Faz/Görev/Kilometre Taşı, start AND end dates. */
async function birchWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Proje Planı');
  ws.addRow(['Birch Strateji Ekibi YZ Asistanı – Proje Planı']);
  ws.addRow(["Tüm ajanlar Faz 2'de paralel geliştirilir · Hazırlayan: Alpha"]);
  ws.addRow(['Proje başlangıç tarihi (Pazartesi):', '', '', '2026-10-05']);
  ws.addRow(['Bugün:', '', '', '2026-10-02']);
  ws.addRow(['', '', '', '', '', '', '', '', '', '', '', '', '2026-10-05', '2026-10-12']);
  ws.addRow(['ID', 'Faz / Görev', 'İş Akışı', 'Sorumlu', 'Başl. Hf.', 'Bitiş Hf.', 'Süre (hf)', 'Başlangıç', 'Bitiş', 'Teslimat / Kilometre Taşı', 'Durum', 'Tip', '1', '2']);
  ws.addRow(['PM', 'Proje Yönetimi – çevik/iteratif', 'Proje Yönetimi', 'Alpha', 1, 11, 11, '2026-10-05', '2026-12-18', '', 'Başlamadı', 'Görev']);
  ws.addRow(['F0', 'Faz 0 – Keşif ve Tasarım', '', '', 1, 2, 2, '2026-10-05', '2026-10-16', '', 'Başlamadı', 'Faz']);
  ws.addRow(['0.1', 'Proje başlangıcı (kick-off), yönetişim ve iletişim planı', 'Proje Yönetimi', 'Alpha', 1, 1, 1, '2026-10-05', '2026-10-09', '', 'Başlamadı', 'Görev']);
  ws.addRow(['0.2', 'Tenant / izin envanteri, Entra ID uygulama kaydı', 'Güvenlik', 'Birch BT', 1, 2, 2, '2026-10-05', '2026-10-16', '', 'Devam', 'Görev']);
  ws.addRow(['0.7', 'Tasarım onayı', 'Tümü', 'Strateji Ekibi', 2, 2, 1, '2026-10-12', '2026-10-16', 'Tasarım Onayı', 'Tamamlandı', 'Kilometre Taşı']);
  ws.addRow(['F1', 'Faz 1 – Altyapı ve Platform Kurulumu', '', '', 3, 4, 2, '2026-10-19', '2026-10-30', '', 'Başlamadı', 'Faz']);
  ws.addRow(['1.1', 'Azure ortamları (Dev/Test/Prod), VNet, Key Vault', 'Platform', 'Alpha', 3, 3, 1, '2026-10-19', '2026-10-23', '', 'Başlamadı', 'Görev']);
  ws.addRow(['2.10', 'Admin paneli: roller, eşikler, şablonlar', 'Admin Paneli', 'Alpha', 5, 8, 4, '2026-11-02', '2026-11-27', '', 'Bloke', 'Görev']);
  ws.addRow([]);
  ws.addRow(['', 'Notlar:']);
  const ms = wb.addWorksheet('Kilometre Taşları');
  ms.addRow(['Kilometre Taşları ve Teslimatlar']);
  ms.addRow([]);
  ms.addRow(['Kod', 'Teslimat / Kilometre Taşı', 'Açıklama', 'Hafta', 'Hedef Tarih', 'Sorumlu']);
  ms.addRow(['T-01', 'Detay Tasarım ve Mimari Dokümanı', 'Faz 0 çıktısı', 2, '2026-10-16', 'Alpha']);
  ms.addRow(['KT-4', 'Go-Live', 'Canlıya geçiş', 11, '2026-12-18', 'Alpha + Birch BT']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('plan parser: the Birch layout', () => {
  it('uses the header, takes the END date as the target, treats Faz rows as sections, and reads numeric ids', async () => {
    const { tasks } = parsePlanSheet(await preRead('Birch_Plan.xlsx', await birchWorkbook()), 2026);
    const byId = Object.fromEntries(tasks.map((t) => [t.extId, t]));
    expect(Object.keys(byId)).toEqual(['PM', 'PM'].slice(0, 0).concat(['0.1', '0.2', '0.7', '1.1', '2.10', 'T-01', 'KT-4']));
    expect(byId['0.1']).toMatchObject({ section: 'Faz 0 – Keşif ve Tasarım', owner: 'Alpha', dueDate: '2026-10-09', status: 'Planlandı' });
    expect(byId['0.2']).toMatchObject({ owner: 'Birch BT', dueDate: '2026-10-16', status: 'Devam' });
    expect(byId['0.7']).toMatchObject({ status: 'Tamamlandı', title: 'Tasarım onayı' });
    expect(byId['1.1'].section).toBe('Faz 1 – Altyapı ve Platform Kurulumu');
    expect(byId['2.10']).toMatchObject({ status: 'Bloke', dueDate: '2026-11-27' });
    expect(byId['T-01']).toMatchObject({ dueDate: '2026-10-16', owner: 'Alpha', title: 'Detay Tasarım ve Mimari Dokümanı' });
    expect(byId['KT-4'].owner).toBe('Alpha + Birch BT');
  });
  it('week header dates and the notes are not tasks', async () => {
    const { tasks } = parsePlanSheet(await preRead('Birch_Plan.xlsx', await birchWorkbook()), 2026);
    expect(tasks.some((t) => /notlar/i.test(t.title) || t.extId.startsWith('2026'))).toBe(false);
  });
});

describe('edit validation: the model proposes, code decides', () => {
  const plan: PlanTask[] = [
    { extId: 'W1.1', section: 'D1', title: 'A', owner: 'Burak', dependsOn: null, dueDate: '2026-09-09', status: 'Planlandı' },
    { extId: 'W1.2', section: 'D1', title: 'B', owner: 'Mesut', dependsOn: 'W1.1', dueDate: null, status: 'Devam' },
  ];
  it('keeps real edits and rejects unknown ids, bad statuses and unreadable dates', () => {
    const { changes, rejected } = validateEdits(plan, [
      { ext_id: 'W1.1', field: 'status', value: 'bitti' },
      { ext_id: 'W9.9', field: 'status', value: 'Devam' },
      { ext_id: 'W1.2', field: 'status', value: 'harika' },
      { ext_id: 'W1.2', field: 'due_date', value: 'yarın sabah' },
      { ext_id: 'W1.2', field: 'due_date', value: '2026-10-30' },
      { ext_id: 'W1.2', field: 'status', value: 'Devam' }, // no change
    ], [], 2026);
    expect(changes.map((c) => [c.extId, c.field, c.to])).toEqual([['W1.1', 'status', 'Tamamlandı'], ['W1.2', 'due_date', '2026-10-30']]);
    expect(rejected).toHaveLength(3);
  });
  it('adds a new task only with a fresh, well-formed id', () => {
    const { changes, rejected } = validateEdits(plan, [], [
      { ext_id: 'W1.3', section: 'D1', title: 'C', owner: null, due_date: '2026-10-01', status: null, depends_on: null },
      { ext_id: 'W1.1', section: null, title: 'dup', owner: null, due_date: null, status: null, depends_on: null },
      { ext_id: 'x y', section: null, title: 't', owner: null, due_date: null, status: null, depends_on: null },
    ], 2026);
    expect(changes).toHaveLength(1);
    expect(changes[0].task).toMatchObject({ extId: 'W1.3', status: 'Planlandı', dueDate: '2026-10-01' });
    expect(rejected).toHaveLength(2);
  });
});

/* ---------- over HTTP ---------- */

const files = new Map<string, Buffer>();
let db: Db;
let server: Server;
let base: string;
let proposal: PlanEditProposal = { edits: [], added: [], notes: [] };
let extraction: Extraction = { rows: [], mappings: [], notes: [] };

const ai: Ai = {
  model: 'fake',
  extract: async () => extraction,
  pick: async () => ({}),
  chat: async () => ({ content: 'ok', toolCalls: [] }),
  extractPlan: async () => ({ tasks: [], notes: [] }),
  editPlan: async () => proposal,
};

class Client {
  cookie = '';
  async login(email: string, name: string, role?: string) {
    const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, role, tenant: 'tenant-a' }) });
    this.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    return this;
  }
  async call(method: string, path: string, body?: unknown) {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie: this.cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }
  async form(path: string, fields: Record<string, string>, file?: { name: string; data: Buffer }) {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    if (file) f.set('file', new Blob([file.data]), file.name);
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: this.cookie }, body: f });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }
}

let cansu: Client, mesut: Client, outsider: Client, projectId: string;

beforeAll(async () => {
  db = await testDb();
  const ctx: Ctx = { db, ai, blob: { put: async (path, data) => { files.set(path, data); }, get: async (path) => files.get(path) ?? Buffer.from('x') }, today: () => '2026-10-12' };
  server = buildApp(ctx, { get: async () => ({}) }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cansu = await new Client().login('cansu@x.com', 'Cansu', 'PM');
  mesut = await new Client().login('mesut@x.com', 'Mesut Yılmaz');
  outsider = await new Client().login('out@x.com', 'Dış');
  projectId = (await cansu.call('POST', '/api/projects', { name: 'Ajan Fabric' })).body.id;
  const ids = (await db.query(`SELECT id FROM employees WHERE email='mesut@x.com'`)).rows.map((r) => r.id);
  await cansu.call('PUT', `/api/projects/${projectId}/members`, { employeeIds: ids });
});
afterAll(() => { server.close(); });

describe('import a plan from Excel', () => {
  let actionId: string;
  it('stages the plan, saves nothing, and only the PM can do it', async () => {
    const file = { name: 'plan.xlsx', data: await trackerWorkbook() };
    expect((await mesut.form(`/api/projects/${projectId}/plan/import`, {}, file)).status).toBe(403);
    const r = await cansu.form(`/api/projects/${projectId}/plan/import`, {}, file);
    expect(r.status).toBe(200);
    expect(r.body.tasks).toHaveLength(4);
    expect(r.body.lines[0]).toContain('Ekle W0.1');
    actionId = r.body.actionId;
    expect((await cansu.call('GET', `/api/projects/${projectId}/plan`)).body).toHaveLength(0); // not saved yet
  });
  it('applies on click: tasks with dates and owner links appear', async () => {
    expect((await mesut.call('POST', `/api/pending/${actionId}/apply`)).status).toBe(404);
    expect((await cansu.call('POST', `/api/pending/${actionId}/apply`)).status).toBe(200);
    const plan = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body;
    expect(plan.map((t: any) => [t.ext_id, t.due_date, t.status])).toEqual([['W0.1', '2026-08-08', 'Planlandı'], ['W0.2', '2026-08-15', 'Devam'], ['W1.1', '2026-09-09', 'Tamamlandı'], ['W1.4', '2026-09-23', 'Planlandı']]);
    expect(plan[0].owner_id).not.toBeNull(); // "Mesut" matched Mesut Yılmaz by first name
    expect((await mesut.call('GET', `/api/projects/${projectId}/plan`)).body).toHaveLength(4); // members can read
    expect((await outsider.call('GET', `/api/projects/${projectId}/plan`)).status).toBe(403);
  });
  it('re-importing updates by id instead of duplicating', async () => {
    const r = await cansu.form(`/api/projects/${projectId}/plan/import`, {}, { name: 'plan.xlsx', data: await trackerWorkbook() });
    expect(r.body.lines[0]).toContain('Güncelle W0.1');
    await cansu.call('POST', `/api/pending/${r.body.actionId}/apply`);
    expect((await cansu.call('GET', `/api/projects/${projectId}/plan`)).body).toHaveLength(4);
  });
  it('a file without a plan stages nothing', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x').addRow(['a', 'b']);
    const r = await cansu.form(`/api/projects/${projectId}/plan/import`, {}, { name: 'empty.xlsx', data: Buffer.from(await wb.xlsx.writeBuffer()) });
    expect(r.body.actionId).toBeNull();
    expect(r.body.notes[0]).toContain('bulunamadı');
  });
});

describe('plan tasks are workable: people log effort against them', () => {
  it('shows my tasks (own first), links by plan code, and reports the hours on the task', async () => {
    const mine = (await mesut.call('GET', '/api/my-tasks')).body;
    expect(mine.filter((t: any) => t.kind === 'project').map((t: any) => t.title)).toEqual(['W0.1 Agent 365 kiracı kurulumu', 'W1.4 A04 Service Desk Controller Agent']); // Mesut's own, not Burak's
    expect(mine[0]).toMatchObject({ project: 'Ajan Fabric', due: '2026-08-08', status: 'Planlandı' });

    extraction = { mappings: [], notes: [], rows: [{ date: 'pzt', time: null, effort: '3s', description: 'W1.4 için toplantı', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L1', source_text: 'pzt W1.4 için toplantı 3s' }] };
    const up = await mesut.form('/api/uploads', {}, { name: 'hafta41.txt', data: Buffer.from('pzt W1.4 için toplantı 3s') });
    const detail = (await mesut.call('GET', `/api/uploads/${up.body.uploadId}`)).body;
    expect(detail.rows[0]).toMatchObject({ link_kind: 'project', link_via: 'explicit-id' });
    expect((await mesut.call('POST', `/api/uploads/${up.body.uploadId}/confirm`)).status).toBe(200);

    const rep = (await cansu.call('POST', '/api/reports/run', { definition: { from: '2026-10-01', to: '2026-10-31', groupBy: ['task'], filters: { linkKind: 'project' } } })).body;
    expect(rep.rows).toEqual([expect.objectContaining({ g0: 'W1.4 A04 Service Desk Controller Agent', hours: 3 })]);
  });
  it('a quick entry from the task list links to the task', async () => {
    const t = (await mesut.call('GET', '/api/my-tasks')).body.find((x: any) => x.title.startsWith('W0.1'));
    const e = await mesut.call('POST', '/api/entries', { date: '2026-10-07', hours: 2, description: t.title, projectId: t.projectId, link: { kind: 'project', id: t.id } });
    expect(e.body).toMatchObject({ link_kind: 'project', saved: true });
    expect((await mesut.call('POST', '/api/entries', { date: '2026-10-07', hours: 1, link: { kind: 'project', id: '00000000-0000-0000-0000-000000000000' } })).status).toBe(400);
  });
});

describe('update the plan with the assistant', () => {
  it('proposes validated changes, applies only on click, and lists what was refused', async () => {
    proposal = {
      edits: [
        { ext_id: 'W1.4', field: 'status', value: 'Tamamlandı' },
        { ext_id: 'W0.2', field: 'due_date', value: '2026-11-15' },
        { ext_id: 'W7.7', field: 'status', value: 'Devam' },
      ],
      added: [{ ext_id: 'W1.6', section: 'Dalga 1 — İzleme MVP (Eyl 2026)', title: 'Dashboard', owner: 'Burak', due_date: '2026-10-20', status: null, depends_on: 'W1.4' }],
      notes: [],
    };
    expect((await mesut.call('POST', `/api/projects/${projectId}/plan/assist`, { instruction: 'x' })).status).toBe(403);
    const r = (await cansu.call('POST', `/api/projects/${projectId}/plan/assist`, { instruction: 'W1.4 tamamlandı, W0.2 15 Kasım, dashboard görevi ekle' })).body;
    expect(r.lines).toHaveLength(3);
    expect(r.rejected).toEqual([expect.stringContaining('W7.7')]);
    const before = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body;
    expect(before.find((t: any) => t.ext_id === 'W1.4').status).toBe('Planlandı'); // nothing changed yet

    expect((await cansu.call('POST', `/api/pending/${r.actionId}/apply`)).status).toBe(200);
    const after = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body;
    expect(after.find((t: any) => t.ext_id === 'W1.4').status).toBe('Tamamlandı');
    expect(after.find((t: any) => t.ext_id === 'W0.2').due_date).toBe('2026-11-15');
    expect(after.find((t: any) => t.ext_id === 'W1.6')).toMatchObject({ title: 'Dashboard', due_date: '2026-10-20', status: 'Planlandı' });
    expect((await cansu.call('POST', `/api/pending/${r.actionId}/apply`)).status).toBe(409); // once only
  });
  it('an instruction that yields nothing usable stages nothing', async () => {
    proposal = { edits: [{ ext_id: 'NOPE', field: 'status', value: 'Devam' }], added: [], notes: ['belirsiz'] };
    const r = (await cansu.call('POST', `/api/projects/${projectId}/plan/assist`, { instruction: 'bir şeyi değiştir' })).body;
    expect(r.actionId).toBeNull();
    expect(r.rejected).toHaveLength(1);
  });
  it('a PM can also change a status or date directly in the table; employees cannot', async () => {
    const t = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body.find((x: any) => x.ext_id === 'W0.1');
    expect((await mesut.call('PATCH', `/api/projects/${projectId}/plan/${t.id}`, { status: 'Devam' })).status).toBe(403);
    expect((await cansu.call('PATCH', `/api/projects/${projectId}/plan/${t.id}`, { status: 'olmaz' })).status).toBe(400);
    expect((await cansu.call('PATCH', `/api/projects/${projectId}/plan/${t.id}`, { status: 'Devam', due_date: '2026-10-30' })).status).toBe(200);
    const again = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body.find((x: any) => x.ext_id === 'W0.1');
    expect(again).toMatchObject({ status: 'Devam', due_date: '2026-10-30' });
  });
});

describe('a project plan dropped on the file page', () => {
  it('is recognised as a plan and can be sent to a project instead of dead-ending', async () => {
    extraction = { rows: [], mappings: [], notes: ['efor satırı yok'] };
    const up = await cansu.form('/api/uploads', {}, { name: 'Birch_Plan.xlsx', data: await birchWorkbook() });
    expect(up.status).toBe(201);
    const detail = (await cansu.call('GET', `/api/uploads/${up.body.uploadId}`)).body;
    expect(detail.rows).toHaveLength(0);
    expect(detail.plan_tasks).toBe(7);
    expect((await mesut.call('POST', `/api/uploads/${up.body.uploadId}/as-plan`, { projectId })).status).toBe(403);
    const staged = (await cansu.call('POST', `/api/uploads/${up.body.uploadId}/as-plan`, { projectId })).body;
    expect(staged.tasks).toHaveLength(7);
    await cansu.call('POST', `/api/pending/${staged.actionId}/apply`);
    const plan = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body;
    expect(plan.some((t: any) => t.ext_id === '0.1' && t.due_date === '2026-10-09')).toBe(true);
  });
  it('a file with effort rows reports no plan', async () => {
    extraction = { mappings: [], notes: [], rows: [{ date: 'pzt', time: null, effort: '3s', description: 'x', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L1', source_text: 'pzt x 3s' }] };
    const up = await cansu.form('/api/uploads', {}, { name: 'hafta41.txt', data: Buffer.from('pzt x 3s') });
    expect((await cansu.call('GET', `/api/uploads/${up.body.uploadId}`)).body.plan_tasks).toBe(0);
  });
});

describe('deleting efforts, files, plan tasks, plans and projects', () => {
  const entry = async (c: Client, date: string, hours: number, link?: object) =>
    (await c.call('POST', '/api/entries', { date, hours, description: 'sil-' + hours, projectId, ...(link ? { link } : {}) })).body;

  it('deletes several efforts at once, counts what it could not delete, and can undo', async () => {
    const a = await entry(mesut, '2026-09-01', 1);
    const b = await entry(mesut, '2026-09-02', 2);
    const other = await entry(cansu, '2026-09-03', 3);
    const r = (await mesut.call('POST', '/api/entries/delete', { ids: [a.id, b.id, other.id] })).body;
    expect(r.deleted.sort()).toEqual([a.id, b.id].sort());
    expect(r.skipped).toBe(1); // somebody else's row is never touched
    expect((await db.query(`SELECT deleted FROM entries WHERE id=$1`, [other.id])).rows[0].deleted).toBe(false);
    expect((await cansu.call('POST', `/api/entries/${a.id}/restore`)).status).toBe(404); // not hers
    expect((await mesut.call('POST', `/api/entries/${a.id}/restore`)).body.deleted).toBe(false);
    await db.query(`UPDATE entries SET status='approved' WHERE id=$1`, [a.id]);
    expect((await mesut.call('POST', '/api/entries/delete', { ids: [a.id] })).body).toMatchObject({ deleted: [], skipped: 1 }); // approved rows stay
  });

  it('deletes a whole file with every row it produced, but not when some rows are locked', async () => {
    extraction = { mappings: [], notes: [], rows: [
      { date: 'pzt', time: null, effort: '2s', description: 'a', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L1', source_text: 'pzt a 2s' },
      { date: 'salı', time: null, effort: '3s', description: 'b', task_hint: null, ticket_hint: null, project_hint: null, leave: false, confidence: 0.9, source: 'L2', source_text: 'salı b 3s' }] };
    const up = (await mesut.form('/api/uploads', {}, { name: 'sil-hafta.txt', data: Buffer.from('pzt a 2s\nsalı b 3s') })).body;
    await mesut.call('POST', `/api/uploads/${up.uploadId}/confirm`);
    const ids = (await db.query(`SELECT id FROM entries WHERE upload_id=$1`, [up.uploadId])).rows.map((x) => x.id);
    await db.query(`UPDATE entries SET status='approved' WHERE id=$1`, [ids[0]]);
    expect((await mesut.call('DELETE', `/api/uploads/${up.uploadId}`)).status).toBe(409);
    expect((await db.query(`SELECT count(*)::int AS n FROM entries WHERE upload_id=$1 AND NOT deleted`, [up.uploadId])).rows[0].n).toBe(2); // all or nothing
    await db.query(`UPDATE entries SET status='confirmed' WHERE id=$1`, [ids[0]]);
    expect((await cansu.call('DELETE', `/api/uploads/${up.uploadId}`)).status).toBe(404);
    expect((await mesut.call('DELETE', `/api/uploads/${up.uploadId}`)).body).toEqual({ deleted: 2 });
    expect((await mesut.call('GET', '/api/uploads')).body.find((u: any) => u.id === up.uploadId)?.status).toBe('discarded');
  });

  it('deleting a plan task clears the links of the effort logged on it; only the PM may', async () => {
    const t = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body.find((x: any) => x.ext_id === 'W1.1');
    const e = await entry(mesut, '2026-09-04', 4, { kind: 'project', id: t.id });
    expect(e.link_id).toBe(t.id);
    expect((await mesut.call('DELETE', `/api/projects/${projectId}/plan/${t.id}`)).status).toBe(403);
    expect((await cansu.call('DELETE', `/api/projects/${projectId}/plan/${t.id}`)).status).toBe(200);
    expect((await cansu.call('DELETE', `/api/projects/${projectId}/plan/${t.id}`)).status).toBe(404);
    expect((await db.query(`SELECT link_kind, link_id FROM entries WHERE id=$1`, [e.id])).rows[0]).toEqual({ link_kind: null, link_id: null });
    expect((await db.query(`SELECT 1 FROM entries WHERE id=$1 AND NOT deleted`, [e.id])).rows).toHaveLength(1); // the hours themselves stay
  });

  it('deletes the whole plan but keeps the project, team and logged hours', async () => {
    const before = (await cansu.call('GET', `/api/projects/${projectId}/plan`)).body.length;
    expect(before).toBeGreaterThan(0);
    expect((await cansu.call('DELETE', `/api/projects/${projectId}/plan`)).body).toEqual({ deleted: before });
    expect((await cansu.call('GET', `/api/projects/${projectId}/plan`)).body).toHaveLength(0);
    expect((await mesut.call('GET', '/api/projects')).body.map((p: any) => p.id)).toContain(projectId);
  });

  it('unlinks a Planner plan: its cached tasks and their links go, a shared plan stays', async () => {
    // Linked straight in the database: the POST route also starts a background sync, which with this fake Graph would empty the plan.
    await db.query(`INSERT INTO project_plans (project_id, tenant_id, plan_id, plan_title) VALUES ($1,'tenant-a','planX','X')`, [projectId]);
    await db.query(`INSERT INTO planner_tasks (tenant_id, id, plan_id, title) VALUES ('tenant-a','pt1','planX','Görev X')`);
    const e = await entry(mesut, '2026-09-05', 1, { kind: 'planner', id: 'pt1', tenantId: 'tenant-a' });
    expect(e.link_kind).toBe('planner');
    expect((await mesut.call('DELETE', `/api/projects/${projectId}/plans/tenant-a/planX`)).status).toBe(403);
    expect((await cansu.call('DELETE', `/api/projects/${projectId}/plans/tenant-a/planX`)).body).toEqual({ removedTasks: 1 });
    expect((await db.query(`SELECT count(*)::int AS n FROM planner_tasks WHERE plan_id='planX'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT link_kind FROM entries WHERE id=$1`, [e.id])).rows[0].link_kind).toBeNull();
    expect((await cansu.call('DELETE', `/api/projects/${projectId}/plans/tenant-a/planX`)).status).toBe(404);
  });

  it('"deleting" a project hides it everywhere and stops its sync, but reports keep the hours', async () => {
    const pid = (await cansu.call('POST', '/api/projects', { name: 'Silinecek', plans: [{ tenantId: 'tenant-a', planId: 'planY', title: 'Y' }] })).body.id;
    expect((await mesut.call('DELETE', `/api/projects/${pid}`)).status).toBe(403);
    expect((await cansu.call('DELETE', `/api/projects/${pid}`)).status).toBe(200);
    expect((await cansu.call('GET', '/api/projects')).body.map((p: any) => p.id)).not.toContain(pid);
    const { syncAll } = await import('../src/server/graph.js');
    const seen: string[] = [];
    await syncAll(db, { get: async (_t: string, path: string) => { seen.push(path); return { value: [], title: 't' }; } });
    expect(seen.some((p) => p.includes('planY'))).toBe(false);
  });
});

describe('a Planner plan belongs to one project', () => {
  it('refuses to link a plan twice, names the project that holds it, and never moves it silently', async () => {
    const first = (await cansu.call('POST', '/api/projects', { name: 'Birinci', plans: [{ tenantId: 'tenant-a', planId: 'shared1', title: 'Paylaşılan' }] })).body.id;
    const dup = await cansu.call('POST', '/api/projects', { name: 'İkinci', plans: [{ tenantId: 'tenant-a', planId: 'shared1', title: 'Paylaşılan' }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain('“Birinci”');
    // the failed create left nothing behind
    expect((await db.query(`SELECT count(*)::int AS n FROM projects WHERE name='İkinci'`)).rows[0].n).toBe(0);

    const other = (await cansu.call('POST', '/api/projects', { name: 'Üçüncü' })).body.id;
    expect((await cansu.call('POST', `/api/projects/${other}/plans`, { tenantId: 'tenant-a', planId: 'shared1', title: 'Paylaşılan' })).status).toBe(409);
    expect((await db.query(`SELECT project_id FROM project_plans WHERE plan_id='shared1'`)).rows[0].project_id).toBe(first); // still the first project's

    // linking it again to the same project is harmless
    expect((await cansu.call('POST', `/api/projects/${first}/plans`, { tenantId: 'tenant-a', planId: 'shared1', title: 'Paylaşılan' })).status).toBe(200);
  });

  it('a plan held by a deleted project is free to use again', async () => {
    const held = (await db.query(`SELECT project_id FROM project_plans WHERE plan_id='shared1'`)).rows[0].project_id;
    expect((await cansu.call('DELETE', `/api/projects/${held}`)).status).toBe(200);
    const again = await cansu.call('POST', '/api/projects', { name: 'Yeniden', plans: [{ tenantId: 'tenant-a', planId: 'shared1', title: 'Paylaşılan' }] });
    expect(again.status).toBe(201);
    expect((await db.query(`SELECT project_id FROM project_plans WHERE plan_id='shared1'`)).rows[0].project_id).toBe(again.body.id);
  });

  it('several projects can be added one after another', async () => {
    for (const n of ['A', 'B', 'C']) expect((await cansu.call('POST', '/api/projects', { name: 'Seri ' + n })).status).toBe(201);
    const names = (await cansu.call('GET', '/api/projects')).body.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Seri A', 'Seri B', 'Seri C']));
  });
});
