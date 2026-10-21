import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { testDb } from './testdb.js';
import type { Ai } from '../src/server/ai.js';
import type { Ctx } from '../src/server/context.js';
import type { Db } from '../src/server/db.js';
import { confirmUpload, DuplicateUploadError, NotConfirmable, processUpload } from '../src/server/pipeline.js';
import { createEntry, updateEntry, weekView } from '../src/server/entries.js';
import type { Extraction, ProposedRow } from '../src/core/types.js';

const row = (p: Partial<ProposedRow>): ProposedRow => ({
  date: null, time: null, effort: null, description: '', task_hint: null, ticket_hint: null, project_hint: null,
  leave: false, confidence: 0.9, source: 'L1', source_text: '', ...p,
});

const noteExtraction: Extraction = {
  mappings: [], notes: [],
  rows: [
    row({ date: 'pzt', effort: '3s', description: 'müşteri toplantısı', source: 'L1', source_text: 'pzt - müşteri toplantısı 3s' }),
    row({ date: 'salı', time: '09:00-12:30', description: 'lisans raporu', source: 'L2', source_text: 'salı 09:00-12:30 lisans raporu' }),
    row({ date: 'salı', effort: 'yarım gün', description: 'test', source: 'L3', source_text: '+ öğleden sonra yarım gün test' }),
    row({ date: 'çrş', description: 'izin', leave: true, source: 'L4', source_text: 'çrş izin' }),
    row({ date: 'per.', effort: '2,5 saat', description: 'firewall', source: 'L5', source_text: 'per. 2,5 saat firewall' }),
  ],
};

let extractCalls = 0;
const fakeAi = (ex: () => Extraction): Ai => ({
  model: 'fake',
  async extract() { extractCalls++; return ex(); },
  async pick() { return {}; },
  async chat() { return { content: 'ok', toolCalls: [] }; },
});

let db: Db;
let ctx: Ctx;
let emp: string;
let proj: string;

beforeAll(async () => {
  db = await testDb();
  ctx = { db, ai: fakeAi(() => noteExtraction), blob: { put: async () => {}, get: async () => Buffer.alloc(0) }, today: () => '2026-10-12' };
  await db.query(`INSERT INTO tenants (id,name,domain) VALUES ('t1','Alpha','alpha.example.com')`);
  emp = (await db.query(`INSERT INTO employees (name,email) VALUES ('Ayşe','ayse@alpha.example.com') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO identities (employee_id, tenant_id, email, entra_oid) VALUES ($1,'t1','ayse@alpha.example.com','oid-ayse')`, [emp]);
  proj = (await db.query(`INSERT INTO projects (name, tenant_id) VALUES ('Lisans','t1') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO project_plans (project_id, tenant_id, plan_id, plan_title) VALUES ($1,'t1','plan1','Lisans planı')`, [proj]);
  await db.query(`INSERT INTO employee_projects VALUES ($1,$2)`, [emp, proj]);
  await db.query(`INSERT INTO planner_tasks (tenant_id,id,plan_id,bucket,title,assignee_oids) VALUES
    ('t1','task-rapor','plan1','Raporlama','Lisans raporu','{oid-ayse}'),
    ('t1','task-uat','plan1','UAT','Test','{oid-ayse}')`);
});

const upload = (name: string, buf: Buffer) => processUpload(ctx, { employeeId: emp, dayHours: 8, channel: 'page', fileName: name, buf });

describe('text note end to end', () => {
  let uploadId: string;
  it('turns the note into reviewed draft rows with links', async () => {
    const r = await upload('ayse_hafta41.txt', Buffer.from('pzt - müşteri toplantısı 3s\nsalı ...'));
    uploadId = r.uploadId;
    expect(r.path).toBe('text-ai');
    expect(r.rows).toBe(4);
    expect(r.notes.some((n) => n.includes('İzin'))).toBe(true);
    const rows = (await db.query(`SELECT work_date, hours, link_id, link_via, status FROM entries WHERE upload_id=$1 ORDER BY work_date, created_at`, [uploadId])).rows;
    expect(rows.map((x) => [x.work_date, x.hours])).toEqual([['2026-10-05', 3], ['2026-10-06', 3.5], ['2026-10-06', 4], ['2026-10-08', 2.5]]);
    expect(rows.every((x) => x.status === 'draft')).toBe(true);
    expect(rows[1].link_id).toBe('task-rapor');
    expect(rows[0].link_id).toBeNull(); // "müşteri toplantısı" matches nothing: left for the person to pick
  });
  it('stops the same file uploaded twice', async () => {
    await expect(upload('copy.txt', Buffer.from('pzt - müşteri toplantısı 3s\nsalı ...'))).rejects.toBeInstanceOf(DuplicateUploadError);
  });
  it('saves nothing until the person confirms, and only the owner can confirm', async () => {
    expect((await db.query(`SELECT count(*)::int AS n FROM entries WHERE status<>'draft'`)).rows[0].n).toBe(0);
    await expect(confirmUpload(db, '00000000-0000-0000-0000-000000000000', uploadId)).rejects.toBeInstanceOf(NotConfirmable);
    const r = await confirmUpload(db, emp, uploadId);
    expect(r.confirmed).toBe(4);
    await expect(confirmUpload(db, emp, uploadId)).rejects.toBeInstanceOf(NotConfirmable);
  });
  it('shows the week with totals and missing days', async () => {
    const w = await weekView(db, emp, '2026-10-07', '2026-10-12');
    expect(w.total).toBe(13);
    expect(w.days.find((d) => d.date === '2026-10-07')?.missing).toBe(true); // Wednesday: leave, not entered
    expect(w.days.find((d) => d.date === '2026-10-09')?.missing).toBe(true);
  });
});

describe('blocked rows', () => {
  it('cannot be confirmed until fixed', async () => {
    const bad: Extraction = { mappings: [], notes: [], rows: [row({ date: 'pzt', effort: '9s', description: 'x', source_text: 'pzt x 3s' })] };
    ctx = { ...ctx, ai: fakeAi(() => bad) };
    const r = await upload('bad.txt', Buffer.from('pzt x 3s'));
    await expect(confirmUpload(db, emp, r.uploadId)).rejects.toBeInstanceOf(NotConfirmable);
    const id = (await db.query(`SELECT id FROM entries WHERE upload_id=$1`, [r.uploadId])).rows[0].id;
    const fixed = await updateEntry(ctx, emp, id, { hours: 3 }, 8);
    expect(fixed.flags).not.toContain('number_not_in_source');
    expect((await confirmUpload(db, emp, r.uploadId)).confirmed).toBe(1);
  });
});

async function xlsx(rows: (string | number | Date)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Efor');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('layout templates', () => {
  const header = ['Tarih', 'Açıklama', 'Efor'];
  const mapping = [{ sheet: 'Efor', header_row: 1, date: 'A', start: null, end: null, effort: 'C', description: 'B', task: null, ticket: null, project: null }];
  it('first upload uses the model; after confirming, the same layout makes no model call', async () => {
    const first: Extraction = {
      mappings: mapping, notes: [],
      rows: [row({ date: '2026-09-28', effort: '4', description: 'Lisans raporu', source: 'Efor!C2', source_text: '2026-09-28 | Lisans raporu | 4' })],
    };
    ctx = { ...ctx, ai: fakeAi(() => first) };
    extractCalls = 0;
    const a = await upload('efor1.xlsx', await xlsx([header, [new Date(Date.UTC(2026, 8, 28)), 'Lisans raporu', 4]]));
    expect(a.path).toBe('ai');
    expect(extractCalls).toBe(1);
    await confirmUpload(db, emp, a.uploadId);

    const b = await upload('efor2.xlsx', await xlsx([header, [new Date(Date.UTC(2026, 8, 29)), 'Test', 2], [new Date(Date.UTC(2026, 8, 30)), 'Rapor', 1.5]]));
    expect(b.path).toBe('template');
    expect(extractCalls).toBe(1);
    expect(b.rows).toBe(2);
  });
});

describe('manual entry', () => {
  it('uses fixed rules for Turkish input and refuses unknown links', async () => {
    const e = await createEntry(ctx, emp, 8, { date: '6 Ekim', hours: 'yarım gün', description: 'elle' });
    expect(e.work_date).toBe('2026-10-06');
    expect(e.hours).toBe(4);
    await expect(createEntry(ctx, emp, 8, { date: '6 Ekim', hours: 1, link: { kind: 'planner', id: 'nope' } })).rejects.toThrow('bulunamadı');
  });
});

describe('empty files', () => {
  it('a file with no effort rows can be read but not confirmed', async () => {
    ctx = { ...ctx, ai: fakeAi(() => ({ rows: [], mappings: [], notes: ['efor sayfası yok'] })) };
    const r = await upload('plan.txt', Buffer.from('proje planı'));
    expect(r.rows).toBe(0);
    await expect(confirmUpload(db, emp, r.uploadId)).rejects.toBeInstanceOf(NotConfirmable);
  });
});

describe('damaged files', () => {
  it('a broken .xlsx gives a clear, specific error instead of a crash', async () => {
    const { UnreadableFileError } = await import('../src/server/pipeline.js');
    await expect(upload('bozuk.xlsx', Buffer.from('this is not a zip file'))).rejects.toBeInstanceOf(UnreadableFileError);
    expect((await db.query(`SELECT status FROM uploads WHERE file_name='bozuk.xlsx'`)).rows[0].status).toBe('failed');
  });
});

describe('Responses API adapters', () => {
  it('turns a tool-calling history into Responses input items, in order', async () => {
    const { toResponsesInput } = await import('../src/server/ai.js');
    const items = toResponsesInput([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'bakıyorum', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'my_effort', arguments: '{"from":"x"}' } }] },
      { role: 'tool', content: '{"toplam":3}', tool_call_id: 'c1' },
      { role: 'assistant', content: 'Toplam 3', },
    ]);
    expect(items).toEqual([
      { role: 'system', content: 'sys' }, { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'bakıyorum' },
      { type: 'function_call', call_id: 'c1', name: 'my_effort', arguments: '{"from":"x"}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"toplam":3}' },
      { role: 'assistant', content: 'Toplam 3' },
    ]);
  });
  it('reads text and function calls out of a Responses output', async () => {
    const { fromResponsesOutput } = await import('../src/server/ai.js');
    expect(fromResponsesOutput([{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Merhaba' }, { type: 'output_text', text: '!' }] }])).toEqual({ content: 'Merhaba!', toolCalls: [] });
    expect(fromResponsesOutput([{ type: 'function_call', call_id: 'k', name: 'add_entries', arguments: '{"text":"x"}' }])).toEqual({ content: null, toolCalls: [{ id: 'k', name: 'add_entries', args: '{"text":"x"}' }] });
  });
});
