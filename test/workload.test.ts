import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import type { Ai, ChatMsg } from '../src/server/ai.js';
import { buildApp } from '../src/server/app.js';
import type { Db } from '../src/server/db.js';
import type { User } from '../src/server/session.js';
import { openTickets, teamWorkload, ticketStats } from '../src/server/workload.js';

let db: Db;
const ids: Record<string, string> = {};
const user = (key: string, role: User['role']): User => ({ employeeId: ids[key], name: key, email: `${key}@x.com`, role, dayHours: 8 });

const addPerson = async (key: string, name: string, role = 'Employee') => {
  ids[key] = (await db.query(`INSERT INTO employees (name,email,role) VALUES ($1,$2,$3) RETURNING id`, [name, `${key}@beta.example.com`, role])).rows[0].id;
  await db.query(`INSERT INTO identities (employee_id, tenant_id, email, entra_oid) VALUES ($1,'t1',$2,$3)`, [ids[key], `${key}@beta.example.com`, `oid-${key}`]);
};
const ticket = (id: string, title: string, status: string, assignee: string | null, customer = 'Acme', closedAt: string | null = null, days = 5) =>
  db.query(`INSERT INTO itsm_tickets (id, tenant_id, title, customer, assignee, status, opened_at, closed_at) VALUES ($1,'t1',$2,$3,$4,$5, now() - ($6 || ' days')::interval, $7)`, [id, title, customer, assignee, status, String(days), closedAt]);

beforeAll(async () => {
  db = await testDb();
  await db.query(`INSERT INTO tenants (id,name,domain) VALUES ('t1','Beta','beta.example.com')`);
  await addPerson('admin', 'Yönetici', 'Admin');
  await addPerson('cansu', 'Cansu Kaya', 'PM');
  await addPerson('murat', 'Murat Aydın');
  await addPerson('selim', 'Selim Erdem');
  const proj = (await db.query(`INSERT INTO projects (name, created_by) VALUES ('Birch Strateji', $1) RETURNING id`, [ids.cansu])).rows[0].id;
  await db.query(`INSERT INTO employee_projects VALUES ($1,$2)`, [ids.murat, proj]); // Selim is NOT on Cansu's project
  await db.query(`INSERT INTO project_plans (project_id, tenant_id, plan_id) VALUES ($1,'t1','plan1')`, [proj]);
  await db.query(`INSERT INTO planner_tasks (tenant_id,id,plan_id,title,assignee_oids,due_date,percent_complete) VALUES
    ('t1','p1','plan1','Firewall devreye al','{oid-murat}','2026-10-20',30), ('t1','p2','plan1','Bitmiş iş','{oid-murat}','2026-10-01',100), ('t1','p3','plan1','Selim görevi','{oid-selim}',NULL,0)`);
  await db.query(`INSERT INTO project_tasks (project_id, ext_id, title, owner_name, owner_id, due_date, status) VALUES
    ($1,'W1.4','Controller ajanı','Murat',$2,'2026-10-25','Devam'), ($1,'W1.5','Bitti','Murat',$2,'2026-09-01','Tamamlandı')`, [proj, ids.murat]);

  await ticket('1001', 'VPN düştü', 'Open', 'murat@beta.example.com', 'Acme', null, 12);
  await ticket('1002', 'Yazıcı', 'In Progress', 'murat@beta.example.com', 'Dogwood', null, 3);
  await ticket('1003', 'Eski iş', 'Closed', 'murat@beta.example.com', 'Acme', '2026-10-01T00:00:00Z');
  await ticket('1004', 'Çözülmüş', 'Çözüldü', 'murat@beta.example.com');
  await ticket('1005', 'Selim işi', 'Open', 'selim@beta.example.com', 'Acme');
  await ticket('1006', 'Atanmamış', 'Open', null, 'Cedar');
  await ticket('1007', 'Dış teknisyen', 'Open', 'dis.kisi@baska.com', 'Cedar');
});

describe('open tickets', () => {
  it('an admin sees every open ticket, closed and resolved ones excluded, with who has them', async () => {
    const r = await openTickets(db, user('admin', 'Admin'));
    expect(r.toplam_acik).toBe(5);
    expect(r.biletler.map((b) => b.no).sort()).toEqual(['1001', '1002', '1005', '1006', '1007']);
    expect(r.kisi_bazinda).toEqual(expect.arrayContaining([{ kisi: 'Murat Aydın', adet: 2 }, { kisi: 'Selim Erdem', adet: 1 }, { kisi: 'atanmamış', adet: 1 }, { kisi: 'dis.kisi@baska.com', adet: 1 }]));
    expect(r.biletler.find((b) => b.no === '1001')).toMatchObject({ sorumlu: 'Murat Aydın', musteri: 'Acme', yas_gun: 12 });
  });
  it('filters by person (even without Turkish letters) and by customer', async () => {
    expect((await openTickets(db, user('admin', 'Admin'), { assignee: 'murat aydin' })).biletler.map((b) => b.no).sort()).toEqual(['1001', '1002']);
    expect((await openTickets(db, user('admin', 'Admin'), { customer: 'cedar' })).toplam_acik).toBe(2);
  });
  it('a PM sees only the people on their own projects, an employee only themselves', async () => {
    const pm = await openTickets(db, user('cansu', 'PM'));
    expect(pm.biletler.map((b) => b.no).sort()).toEqual(['1001', '1002']); // Murat only; not Selim, not unassigned, not outsiders
    const emp = await openTickets(db, user('selim', 'Employee'));
    expect(emp.biletler.map((b) => b.no)).toEqual(['1005']);
  });
});

describe('ticket report', () => {
  it('counts open tickets by technician, customer and status; all tickets on request', async () => {
    const admin = user('admin', 'Admin');
    expect((await ticketStats(db, admin, 'technician')).satirlar).toEqual(expect.arrayContaining([{ ad: 'Murat Aydın', adet: 2 }]));
    expect((await ticketStats(db, admin, 'customer')).satirlar).toEqual(expect.arrayContaining([{ ad: 'Acme', adet: 2 }, { ad: 'Cedar', adet: 2 }, { ad: 'Dogwood', adet: 1 }]));
    expect((await ticketStats(db, admin, 'status')).satirlar).toEqual(expect.arrayContaining([{ ad: 'Open', adet: 4 }, { ad: 'In Progress', adet: 1 }]));
    expect((await ticketStats(db, admin, 'status', false)).toplam).toBe(7);
    expect((await ticketStats(db, user('cansu', 'PM'), 'technician')).toplam).toBe(2);
  });
});

describe('who has what', () => {
  it('lists, per person, open tickets, Planner tasks and project plan tasks (finished ones left out)', async () => {
    const r: any = await teamWorkload(db, user('admin', 'Admin'), { person: 'murat' });
    expect(r.kisi_sayisi).toBe(1);
    const m = r.kisiler[0];
    expect(m).toMatchObject({ kisi: 'Murat Aydın', acik_bilet_sayisi: 2, planner_gorev_sayisi: 1, proje_plani_gorev_sayisi: 1 });
    expect(m.planner_gorevleri[0]).toMatchObject({ gorev: 'Firewall devreye al', proje: 'Birch Strateji', bitis: '2026-10-20', yuzde: 30 });
    expect(m.proje_plani_gorevleri[0]).toMatchObject({ id: 'W1.4', durum: 'Devam', bitis: '2026-10-25' });
  });
  it('can be narrowed to a project, and a PM never sees people outside their projects', async () => {
    const byProject: any = await teamWorkload(db, user('admin', 'Admin'), { project: 'birch' });
    expect(byProject.kisiler.map((k: any) => k.kisi)).toEqual(['Murat Aydın']);
    const pm: any = await teamWorkload(db, user('cansu', 'PM'));
    expect(pm.kisiler.map((k: any) => k.kisi).sort()).toEqual(['Cansu Kaya', 'Murat Aydın']);
    expect(JSON.stringify(pm)).not.toContain('Selim');
    const none: any = await teamWorkload(db, user('cansu', 'PM'), { person: 'selim' });
    expect(none.hata).toBeTruthy();
    expect((await teamWorkload(db, user('admin', 'Admin'), { project: 'yok böyle' }) as any).hata).toContain('bulunamadı');
  });
});

/* ---------- through the assistant ---------- */

describe('asking the assistant', () => {
  let server: Server;
  let base: string;
  let script: (msgs: ChatMsg[]) => { content: string | null; toolCalls: { id: string; name: string; args: string }[] };
  const seenTools: string[][] = [];
  const ai: Ai = {
    model: 'fake', extract: async () => ({ rows: [], mappings: [], notes: [] }), pick: async () => ({}), editPlan: async () => ({ edits: [], added: [], notes: [] }), extractPlan: async () => ({ tasks: [], notes: [] }),
    chat: async (m, tools) => { seenTools.push(tools.map((t) => t.name)); return script(m); },
  };
  const login = async (email: string, role?: string) => {
    const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email, role, tenant: 'tenant-a' }) });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const ask = async (cookie: string, message: string) => {
    const fd = new FormData(); fd.set('message', message);
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { cookie }, body: fd });
    return r.json() as Promise<any>;
  };

  beforeAll(async () => {
    const ctx = { db, ai, blob: {} as any, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-13' };
    server = buildApp(ctx as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('an admin asks "açık biletler, kimin ne görevi var" and the answer comes from the tool results', async () => {
    const cookie = await login('boss@x.com', 'Admin');
    let step = 0;
    script = (msgs) => {
      if (step++ === 0) return { content: null, toolCalls: [{ id: 'a', name: 'open_tickets', args: '{"assignee":null,"customer":null}' }, { id: 'b', name: 'team_workload', args: '{"person":"murat","project":null}' }] };
      const tools = msgs.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content!));
      return { content: `Toplam ${tools[0].toplam_acik} açık bilet var. Murat Aydın: ${tools[1].kisiler[0].acik_bilet_sayisi} bilet.`, toolCalls: [] };
    };
    const r = await ask(cookie, 'açık biletler ne, kimin ne görevi var?');
    expect(r.reply).toBe('Toplam 5 açık bilet var. Murat Aydın: 2 bilet.');
    expect(seenTools[0]).toEqual(expect.arrayContaining(['open_tickets', 'team_workload', 'ticket_stats']));
  });

  it('an employee is not offered these tools, and cannot use them even if the model tries', async () => {
    const cookie = await login('worker@x.com');
    let toolText = '';
    let step = 0;
    script = (msgs) => {
      if (step++ === 0) return { content: null, toolCalls: [{ id: 'a', name: 'open_tickets', args: '{"assignee":null,"customer":null}' }] };
      toolText = msgs.filter((m) => m.role === 'tool').pop()!.content!;
      return { content: 'Bu bilgiyi göremiyorum.', toolCalls: [] };
    };
    await ask(cookie, 'tüm biletleri göster');
    expect(seenTools.at(-2)).not.toContain('open_tickets');
    expect(toolText).toContain('yalnızca yöneticiler');
    expect(toolText).not.toContain('VPN');
  });
});

describe('the Biletler page endpoint', () => {
  let server: Server;
  let base: string;
  const get = async (cookie: string, path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).json() as Promise<any>;
  const login = async (email: string, role?: string) => {
    const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email, role, tenant: 'tenant-a' }) });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  beforeAll(async () => {
    const vault = { get: async () => ({ value: 'k', updatedAt: null }), set: async () => {} };
    const ctx = { db, ai: {} as any, blob: {} as any, vault, itsm: { baseUrl: 'https://sd.example.com', tenantId: 't1', make: () => null }, today: () => '2026-10-13' };
    server = buildApp(ctx as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('shows an admin everything, filters work, and says whether ITSM is connected', async () => {
    const admin = await login('admin2@x.com', 'Admin');
    const all = await get(admin, '/api/tickets');
    expect(all).toMatchObject({ toplam_acik: 5, connected: true, baseUrl: 'https://sd.example.com', scope: 'Admin' });
    expect((await get(admin, '/api/tickets?assignee=murat')).toplam_acik).toBe(2);
    expect((await get(admin, '/api/tickets?customer=cedar')).biletler.map((b: any) => b.no).sort()).toEqual(['1006', '1007']);
    expect((await get(admin, '/api/tickets?open=0')).toplam_acik).toBe(7);
  });

  it('an employee sees only their own tickets (none linked to a stranger), never the team', async () => {
    const stranger = await login('nobody@x.com');
    const r = await get(stranger, '/api/tickets');
    expect(r).toMatchObject({ toplam_acik: 0, scope: 'Employee' });
    expect(r.biletler).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('VPN');
  });

  it('is not available without signing in', async () => {
    expect((await fetch(`${base}/api/tickets`)).status).toBe(401);
  });
});
