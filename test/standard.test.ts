import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import type { Ai } from '../src/server/ai.js';
import { buildApp } from '../src/server/app.js';
import type { Db } from '../src/server/db.js';
import { confirmUpload, NotConfirmable, processUpload } from '../src/server/pipeline.js';
import { preRead } from '../src/core/grid.js';
import { canonicalCategory, parseStandardSheet, sameName } from '../src/core/standard.js';

const TEMPLATE = join(__dirname, 'fixtures', 'Gunluk_Efor_Giris_Sablonu.xlsx');
const clock = (h: number, m: number) => new Date(Date.UTC(1899, 11, 30, h, m)); // how Excel stores a time of day
const day = (d: number) => new Date(Date.UTC(2026, 9, d));

type Fill = Partial<Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'K' | 'L', unknown>>;

/** The real template with rows filled in from row 9, exactly where a person would type them. */
async function filled(rows: Fill[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.getWorksheet('Günlük Efor Girişi')!;
  rows.forEach((r, i) => {
    for (const [col, v] of Object.entries(r)) ws.getCell(`${col}${9 + i}`).value = v as ExcelJS.CellValue;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('the real template', () => {
  it('is recognised, and its four sample rows and 200 blank formula rows give nothing', async () => {
    const pre = await preRead('Gunluk_Efor_Giris_Sablonu.xlsx', readFileSync(TEMPLATE));
    const r = parseStandardSheet(pre)!;
    expect(r).not.toBeNull();
    expect(r.rows).toHaveLength(0);
    expect(r.notes.join(' ')).toContain('4 örnek satır');
  });

  it('reads filled rows by fixed rules: times, categories, customer, product, outcome, progress', async () => {
    const pre = await preRead('efor.xlsx', await filled([
      { A: day(12), B: 'Murat Aydın', C: 'sla', D: 'Elm', E: 'Exchange Bakım / SLA', F: 'Exchange Server', G: 'Mail flow kontrolü yapıldı', H: clock(9, 0), I: clock(10, 30), K: 'Tamamlandı', L: 'tamamlandı' },
      { A: day(12), B: 'Murat Aydın', C: 'Eğitim / Gelişim', D: 'İç Çalışma', E: 'KQL lab', G: 'Sentinel KQL çalışıldı', H: day(12).getTime() + 13 * 3600e3 > 0 ? new Date(Date.UTC(2026, 9, 12, 13, 0)) : '', I: new Date(Date.UTC(2026, 9, 12, 14, 15)), L: 'Devam Ediyor' },
    ]));
    const r = parseStandardSheet(pre)!;
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ date: '2026-10-12', time: '09:00-10:30', description: 'Mail flow kontrolü yapıldı', employee: 'Murat Aydın', project_hint: 'Exchange Bakım / SLA' });
    expect(r.rows[0].extras).toEqual({ category: 'SLA', customer: 'Elm', work_item: 'Exchange Bakım / SLA', product: 'Exchange Server', outcome: 'Tamamlandı', progress: 'Tamamlandı' });
    // a start/end cell that holds a full date-time (as the sample rows do) still gives the time of day
    expect(r.rows[1]).toMatchObject({ time: '13:00-14:15' });
    expect(r.rows[1].extras.progress).toBe('Devam Ediyor');
    expect(r.rows[1].source).toBe('Günlük Efor Girişi!G10');
  });

  it('knows the six categories however they are typed, and ignores the sheet when it is not the form', async () => {
    expect(['sla', 'Teknik Cozum / Ar-Ge', 'İÇ OPERASYON', 'satış destek'].map(canonicalCategory)).toEqual(['SLA', 'Teknik Çözüm / Ar-Ge', 'İç Operasyon', 'Satış Destek']);
    expect(canonicalCategory('Başka')).toBeNull();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x').addRow(['Tarih', 'Saat']);
    expect(parseStandardSheet(await preRead('x.xlsx', Buffer.from(await wb.xlsx.writeBuffer())))).toBeNull();
  });

  it('compares names loosely', () => {
    expect(sameName('Murat Aydın', 'murat aydin')).toBe(true);
    expect(sameName('Murat', 'Murat Aydın')).toBe(true);
    expect(sameName('Başka Kişi', 'Murat Aydın')).toBe(false);
    expect(sameName(null, 'Murat')).toBe(true);
  });
});

describe('uploading the filled form', () => {
  let db: Db;
  let emp: string;
  let modelCalls = 0;
  const ai: Ai = {
    model: 'fake', extract: async () => { modelCalls++; return { rows: [], mappings: [], notes: [] }; }, pick: async () => ({}),
    chat: async () => ({ content: '', toolCalls: [] }), extractPlan: async () => ({ tasks: [], notes: [] }), editPlan: async () => ({ edits: [], added: [], notes: [] }),
  };
  const ctx = () => ({ db, ai, blob: { put: async () => {}, get: async () => Buffer.alloc(0) }, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-13' });

  beforeAll(async () => {
    db = await testDb();
    await db.query(`INSERT INTO tenants (id,name,domain) VALUES ('t1','Beta','beta.example.com')`);
    emp = (await db.query(`INSERT INTO employees (name,email) VALUES ('Murat Aydın','murat@beta.example.com') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO identities (employee_id, tenant_id, email, entra_oid) VALUES ($1,'t1','murat@beta.example.com','o1')`, [emp]);
    const proj = (await db.query(`INSERT INTO projects (name) VALUES ('Cedar Hyper-V') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO employee_projects VALUES ($1,$2)`, [emp, proj]);
  });

  const up = (name: string, buf: Buffer) => processUpload(ctx() as any, { employeeId: emp, dayHours: 8, channel: 'page', fileName: name, buf });

  it('uses the fixed-rule path, never the model, keeps the form fields, and flags what the form forbids', async () => {
    const r = await up('gunluk.xlsx', await filled([
      { A: day(12), B: 'Murat Aydın', C: 'SLA', D: 'Elm', E: 'Exchange Bakım / SLA', F: 'Exchange Server', G: 'Mail flow kontrolü', H: clock(9, 0), I: clock(10, 30), K: 'Tamam', L: 'Tamamlandı' },
      { A: day(12), B: 'Murat Aydın', C: 'Proje', E: 'Cedar Hyper-V', G: 'Cluster network', H: clock(10, 45), I: clock(11, 50) }, // 65 min, no customer
      { A: day(12), B: 'Murat Aydın', C: 'Bilinmeyen kategori', D: 'X', G: 'Başka iş', H: clock(13, 0), I: clock(14, 0) },
      { A: day(12), B: 'Başka Kişi', C: 'İç Operasyon', D: 'İç Çalışma', G: 'Toplantı', H: clock(15, 0), I: clock(16, 0) },
      { B: 'Murat Aydın', C: 'SLA', D: 'Elm', G: 'Tarihi unuttum', H: clock(16, 0), I: clock(17, 0) }, // no date
    ]));
    expect(r.path).toBe('standard');
    expect(r.rows).toBe(5);
    expect(modelCalls).toBe(0);
    expect(r.notes.join(' ')).toContain('4 örnek satır');

    const rows = (await db.query(`SELECT description, hours, category, customer, work_item, product, outcome, progress, flags, project_id FROM entries WHERE upload_id=$1 ORDER BY created_at`, [r.uploadId])).rows;
    expect(rows[0]).toMatchObject({ hours: 1.5, category: 'SLA', customer: 'Elm', work_item: 'Exchange Bakım / SLA', product: 'Exchange Server', outcome: 'Tamam', progress: 'Tamamlandı', flags: [] });
    expect(rows[1].hours).toBe(1.08);
    expect(rows[1].flags).toEqual(expect.arrayContaining(['not_quarter_hour', 'no_customer']));
    expect(rows[1].project_id).not.toBeNull(); // "Cedar Hyper-V" tied the row to the project
    expect(rows[2].flags).toContain('unknown_category');
    expect(rows[3].flags).toContain('name_mismatch');
    expect(rows[4].flags).toContain('no_date');
    expect(rows[2].category).toBe('Bilinmeyen kategori'); // kept as typed, flagged

    // The missing date blocks confirming; warnings alone do not.
    await expect(confirmUpload(db, emp, r.uploadId)).rejects.toBeInstanceOf(NotConfirmable);
    await db.query(`UPDATE entries SET deleted=true WHERE upload_id=$1 AND description='Tarihi unuttum'`, [r.uploadId]);
    expect((await confirmUpload(db, emp, r.uploadId)).confirmed).toBe(4);
  });

  it('the same filled form uploaded again is refused as a duplicate file', async () => {
    const buf = await filled([{ A: day(8), B: 'Murat Aydın', C: 'SLA', D: 'Elm', G: 'Tek', H: clock(9, 0), I: clock(10, 0) }]);
    await up('bir.xlsx', buf);
    await expect(up('iki.xlsx', buf)).rejects.toThrow('daha önce');
  });
});

describe('the template download', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const db = await testDb();
    server = buildApp({ db, ai: {} as any, blob: {} as any, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-13' } as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('needs a sign-in, and serves the very file the upload page understands', async () => {
    expect((await fetch(`${base}/api/template`)).status).toBe(401);
    const login = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.com', name: 'A', tenant: 'tenant-a' }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const r = await fetch(`${base}/api/template`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('Gunluk_Efor_Giris_Sablonu.xlsx');
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.equals(readFileSync(TEMPLATE))).toBe(true);
    expect(parseStandardSheet(await preRead('t.xlsx', body))).not.toBeNull();
  });
});

describe('reports from the form fields', () => {
  it('group by category, customer, project/SLA name and product, and filter by category', async () => {
    const { runEffortReport, PRESETS, definitionSchema } = await import('../src/server/reports.js');
    const db = await testDb();
    await db.query(`INSERT INTO tenants (id,name,domain) VALUES ('t1','Beta','x')`);
    const e = (await db.query(`INSERT INTO employees (name,email,role) VALUES ('Murat','m@x.com','Admin') RETURNING id`)).rows[0].id;
    const add = (d: string, h: number, cat: string | null, cust: string | null, item: string | null, prod: string | null) =>
      db.query(`INSERT INTO entries (employee_id, work_date, hours, description, status, category, customer, work_item, product) VALUES ($1,$2,$3,'x','confirmed',$4,$5,$6,$7)`, [e, d, h, cat, cust, item, prod]);
    await add('2026-10-05', 2, 'SLA', 'Elm', 'Exchange SLA', 'Exchange');
    await add('2026-10-06', 1.5, 'SLA', 'Elm', 'Exchange SLA', 'Exchange');
    await add('2026-10-06', 3, 'SLA', 'Dogwood', 'VMware bakım', 'VMware');
    await add('2026-10-07', 4, 'Proje', 'Cedar', 'Hyper-V', 'Hyper-V');
    await add('2026-10-08', 1, null, null, null, null);
    const admin = { employeeId: e, name: 'Murat', email: 'm@x.com', role: 'Admin' as const, dayHours: 8 };
    const base = { kind: 'effort' as const, from: '2026-10-01', to: '2026-10-31', filters: {} };

    const bycat = await runEffortReport(db, admin, definitionSchema.parse({ ...base, groupBy: ['category'] }));
    expect(bycat.rows.map((r) => [r.g0, r.hours])).toEqual([['(kategorisiz)', 1], ['Proje', 4], ['SLA', 6.5]]);

    const sla = await runEffortReport(db, admin, definitionSchema.parse({ ...base, groupBy: ['entry_customer', 'work_item'], filters: { category: 'SLA' } }));
    expect(sla.rows.map((r) => [r.g0, r.g1, r.hours])).toEqual([['Dogwood', 'VMware bakım', 3], ['Elm', 'Exchange SLA', 3.5]]);
    expect(sla.filters).toContain('kategori: SLA');

    const preset = PRESETS.find((p) => p.id === 'sla-usage')!.build('2026-10-13');
    expect((await runEffortReport(db, admin, definitionSchema.parse(preset))).total).toBe(6.5);
    expect(PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(['category-customer', 'project-effort', 'product-effort']));
    expect(() => definitionSchema.parse({ ...base, groupBy: [], filters: { category: 'Uydurma' } })).toThrow();
  });
});
