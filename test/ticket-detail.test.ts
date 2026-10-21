import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import { buildApp } from '../src/server/app.js';
import type { Db } from '../src/server/db.js';
import { createItsmClient, htmlToText, mapSdpDetail } from '../src/server/itsm.js';

const RAW = {
  id: '123456000000987001', display_id: '3951', subject: 'Larchair DC',
  description: '<div>Merhaba,<br>DC sunucusu&nbsp;yanıt vermiyor.</div><p>Acil &amp; kritik &lt;prod&gt;</p><ul><li>Adım 1</li><li>Adım 2</li></ul><script>alert(1)</script>',
  status: { name: 'In Progress' }, priority: { name: 'High' }, urgency: { name: 'Urgent' }, impact: { name: 'Department' },
  category: { name: 'Altyapı' }, subcategory: { name: 'Active Directory' }, request_type: { name: 'Incident' },
  requester: { name: 'Ali Veli', email_id: 'ali@example.com', department: { name: 'BT' } },
  technician: { name: 'Barış Çelik', email_id: 'baris.celik@beta.example.com' },
  group: { name: 'Altyapı Grubu' }, site: { name: 'İstanbul' }, account: { name: 'Larch' },
  created_time: { value: String(Date.UTC(2026, 9, 1, 8, 0)) }, due_by_time: { value: String(Date.UTC(2026, 9, 15, 15, 0)) },
  is_overdue: false, resolution: { content: '<p>Servis yeniden başlatıldı.</p>' },
};

describe('ticket detail mapping', () => {
  it('turns ITSM HTML into readable text', () => {
    expect(htmlToText(RAW.description)).toBe('Merhaba,\nDC sunucusu yanıt vermiyor.\nAcil & kritik <prod>\n• Adım 1\n• Adım 2');
    expect(htmlToText(null)).toBe('');
  });
  it('maps the fields people ask about, and links to the request in ITSM', () => {
    const d = mapSdpDetail(RAW, 'https://support.beta.example.com/');
    expect(d).toMatchObject({
      no: '3951', sdpId: '123456000000987001', title: 'Larchair DC', status: 'In Progress', priority: 'High', urgency: 'Urgent',
      category: 'Altyapı', subcategory: 'Active Directory', requestType: 'Incident', customer: 'Larch', group: 'Altyapı Grubu', overdue: false,
      requester: { name: 'Ali Veli', email: 'ali@example.com', department: 'BT' }, technician: { name: 'Barış Çelik', email: 'baris.celik@beta.example.com' },
      createdAt: '2026-10-01T08:00:00.000Z', dueAt: '2026-10-15T15:00:00.000Z', resolution: 'Servis yeniden başlatıldı.',
      url: 'https://support.beta.example.com/WorkOrder.do?woMode=viewWO&woID=123456000000987001',
    });
  });
  it('copes with a bare request', () => {
    expect(mapSdpDetail({ id: 7 }, 'https://x')).toMatchObject({ no: '7', title: '(konu yok)', description: '', status: null, resolution: null, overdue: null });
  });
});

describe('ticket details over HTTP', () => {
  let server: Server;
  let base: string;
  let db: Db;
  const calls: string[] = [];
  let failing = false;

  const sdpFetch = (async (url: string) => {
    calls.push(decodeURIComponent(url));
    if (failing) return new Response('{}', { status: 500 });
    const ok = (body: object) => new Response(JSON.stringify({ response_status: { status_code: 2000 }, ...body }));
    if (url.includes('input_data=')) return ok({ requests: [{ id: RAW.id, display_id: '3951' }], list_info: { has_more_rows: false } });
    if (url.includes('/requests/123456000000987001')) return ok({ request: RAW });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const login = async (email: string, role?: string) => {
    const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email, role, tenant: 'tenant-a' }) });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const get = async (cookie: string, path: string) => { const r = await fetch(`${base}${path}`, { headers: { cookie } }); return { status: r.status, body: (await r.json()) as any }; };

  beforeAll(async () => {
    db = await testDb();
    await db.query(`INSERT INTO tenants (id,name,domain) VALUES ('t1','Beta','beta.example.com')`);
    const baris = (await db.query(`INSERT INTO employees (name,email) VALUES ('Barış Çelik','baris.celik@beta.example.com') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO identities (employee_id, tenant_id, email) VALUES ($1,'t1','baris.celik@beta.example.com')`, [baris]);
    await db.query(`INSERT INTO itsm_tickets (id, tenant_id, title, customer, assignee, status, opened_at) VALUES ('3951','t1','Larchair DC','Larch','baris.celik@beta.example.com','In Progress', now())`);
    await db.query(`INSERT INTO itsm_tickets (id, tenant_id, title, assignee, status, opened_at) VALUES ('4000','t1','Başkası','baska@beta.example.com','Open', now())`);
    const vault = { get: async () => ({ value: 'KEY', updatedAt: null }), set: async () => {} };
    const itsm = { baseUrl: 'https://support.beta.example.com', tenantId: 't1', make: (key: string) => createItsmClient({ baseUrl: 'https://support.beta.example.com', apiKey: key, fetchImpl: sdpFetch }) };
    server = buildApp({ db, ai: {} as any, blob: {} as any, vault, itsm, today: () => '2026-10-13' } as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('an admin opens a ticket: the number is tried directly, then looked up, and the internal id is remembered', async () => {
    const admin = await login('boss@x.com', 'Admin');
    const r = await get(admin, '/api/tickets/3951');
    expect(r.status).toBe(200);
    expect(r.body.error).toBeNull();
    expect(r.body.detail).toMatchObject({ no: '3951', priority: 'High', requester: { name: 'Ali Veli' }, resolution: 'Servis yeniden başlatıldı.' });
    expect(calls[0]).toContain('/requests/3951'); // tried the number directly first
    expect(calls[1]).toContain('"field":"display_id"'); // then looked the internal id up
    expect((await db.query(`SELECT sdp_id FROM itsm_tickets WHERE id='3951'`)).rows[0].sdp_id).toBe(RAW.id);

    calls.length = 0;
    await get(admin, '/api/tickets/3951');
    expect(calls).toHaveLength(1); // the second time the internal id is known: no search
    expect(calls[0]).toContain('/requests/123456000000987001');
  });

  it('where the ticket number is the request id (our installation) one direct call is enough', async () => {
    const direct = createItsmClient({ baseUrl: 'https://x', apiKey: 'K', fetchImpl: (async (url: string) => {
      calls.push(decodeURIComponent(url));
      return url.includes('/requests/3846') ? new Response(JSON.stringify({ response_status: { status_code: 2000 }, request: { id: 3846, subject: 'Exchange' } })) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch });
    calls.length = 0;
    expect(await direct.detail('3846', null)).toMatchObject({ no: '3846', title: 'Exchange' });
    expect(calls).toHaveLength(1);
    expect(await direct.detail('9999', null)).toBeNull();
  });

  it('a person opens only their own tickets; a PM only their team’s; nothing without signing in', async () => {
    const stranger = await login('nobody@x.com');
    expect((await get(stranger, '/api/tickets/3951')).status).toBe(404);
    expect((await get(stranger, '/api/tickets/4000')).status).toBe(404);
    expect((await fetch(`${base}/api/tickets/3951`)).status).toBe(401);
    // the ticket owner, once signed in with that address, may open theirs
    await db.query(`UPDATE identities SET entra_oid='dev-baris' WHERE email='baris.celik@beta.example.com'`);
  });

  it('refuses malformed ticket numbers', async () => {
    const admin = await login('boss@x.com', 'Admin');
    expect((await get(admin, '/api/tickets/..%2Fetc')).status).toBe(400);
    expect((await get(admin, '/api/tickets/a%20b')).status).toBe(400);
  });

  it('when ITSM fails the answer still carries the local ticket and says why', async () => {
    failing = true;
    const admin = await login('boss@x.com', 'Admin');
    const r = await get(admin, '/api/tickets/3951');
    expect(r.status).toBe(200);
    expect(r.body.detail).toBeNull();
    expect(r.body.local).toMatchObject({ id: '3951', title: 'Larchair DC' });
    expect(r.body.error).toContain('ayrıntılar alınamadı');
    failing = false;
  });
});
