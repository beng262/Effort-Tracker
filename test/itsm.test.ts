import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import type { Db } from '../src/server/db.js';
import { createItsmClient, mapSdpRequest, runItsmSync } from '../src/server/itsm.js';
import { candidatesFor } from '../src/server/pipeline.js';
import { linkRow } from '../src/core/link.js';

const req = (id: number, subject: string, tech: string | null, extra: object = {}) => ({
  id: String(id), display_id: String(id), subject, status: { name: 'Açık' }, technician: tech ? { email_id: tech } : null,
  created_time: { value: String(Date.UTC(2026, 9, 1)) }, account: { name: 'Acme' }, ...extra,
});

/** A fake ITSM: two pages of tickets, records what it was asked, can be told to fail. */
function fakeSdp(pages: object[][], opts: { code?: number } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const idx = Number(JSON.parse(decodeURIComponent(url.split('input_data=')[1])).list_info.start_index);
    const page = Math.floor((idx - 1) / 2);
    return new Response(JSON.stringify({
      response_status: { status_code: opts.code ?? 2000, messages: opts.code ? [{ message: 'Invalid key' }] : [] },
      requests: pages[page] ?? [], list_info: { has_more_rows: page < pages.length - 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('ITSM mapping', () => {
  it('maps a request: display id, customer, technician e-mail in lower case, dates', () => {
    const t = mapSdpRequest({ id: '9', display_id: '20871', subject: ' Firewall kuralı ', status: { name: 'Çözüldü' }, technician: { email_id: 'murat.aydin@beta.example.com' }, account: { name: 'Dogwood' },
      created_time: { value: String(Date.UTC(2026, 9, 1)) }, completed_time: { value: String(Date.UTC(2026, 9, 3)) } });
    expect(t).toEqual({ id: '20871', sdpId: '9', title: 'Firewall kuralı', customer: 'Dogwood', assignee: 'murat.aydin@beta.example.com', status: 'Çözüldü', openedAt: '2026-10-01T00:00:00.000Z', closedAt: '2026-10-03T00:00:00.000Z' });
  });
  it('copes with missing fields', () => {
    expect(mapSdpRequest({ id: 5 })).toMatchObject({ id: '5', title: '(konu yok)', customer: null, assignee: null, openedAt: null });
  });
});

describe('ITSM client', () => {
  it('follows pages, sends the key and the "changed since" filter', async () => {
    const f = fakeSdp([[req(1, 'a', 'x@y.com'), req(2, 'b', null)], [req(3, 'c', 'x@y.com')]]);
    const sdp = createItsmClient({ baseUrl: 'https://sd.example.com/', apiKey: 'KEY', fetchImpl: f.impl, pageSize: 2 });
    const since = new Date('2026-09-01T00:00:00Z');
    const tickets = await sdp.listChangedSince(since);
    expect(tickets.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].url.startsWith('https://sd.example.com/api/v3/requests?input_data=')).toBe(true);
    expect(f.calls[0].headers.authtoken).toBe('KEY');
    const crit = JSON.parse(decodeURIComponent(f.calls[0].url.split('input_data=')[1])).list_info.search_criteria[0];
    expect(crit).toEqual({ field: 'last_updated_time', condition: 'greater than', value: String(since.getTime()) });
  });
  it('can send the key as TECHNICIAN_KEY', async () => {
    const f = fakeSdp([[]]);
    await createItsmClient({ baseUrl: 'https://sd', apiKey: 'K', header: 'TECHNICIAN_KEY', fetchImpl: f.impl }).listChangedSince(new Date());
    expect(f.calls[0].headers.TECHNICIAN_KEY).toBe('K');
    expect(f.calls[0].headers.authtoken).toBeUndefined();
  });
  it('turns an API-level failure into an error instead of an empty list', async () => {
    const sdp = createItsmClient({ baseUrl: 'https://sd', apiKey: 'bad', fetchImpl: fakeSdp([[]], { code: 4000 }).impl });
    await expect(sdp.listChangedSince(new Date())).rejects.toThrow('4000');
  });
});

describe('syncing and using tickets', () => {
  let db: Db;
  let emp: string;
  const TENANT = 'beta-t';

  beforeAll(async () => {
    db = await testDb();
    await db.query(`INSERT INTO tenants (id,name,domain) VALUES ($1,'Beta','beta.example.com')`, [TENANT]);
    emp = (await db.query(`INSERT INTO employees (name,email) VALUES ('Murat','murat.aydin@beta.example.com') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO identities (employee_id, tenant_id, email) VALUES ($1,$2,'murat.aydin@beta.example.com')`, [emp, TENANT]);
    const proj = (await db.query(`INSERT INTO projects (name) VALUES ('Destek') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO employee_projects VALUES ($1,$2)`, [emp, proj]);
  });

  it('stores tickets, flags the tenant, and a second run reads only what changed', async () => {
    const f1 = fakeSdp([[req(20871, 'Firewall kural düzeltmesi', 'murat.aydin@beta.example.com'), req(20872, 'Başkasının işi', 'baska@beta.example.com')]]);
    const r1 = await runItsmSync(db, createItsmClient({ baseUrl: 'https://sd', apiKey: 'k', fetchImpl: f1.impl }), TENANT);
    expect(r1).toMatchObject({ tickets: 2 });
    expect(Date.now() - new Date(r1.since).getTime()).toBeGreaterThan(80 * 86_400_000); // first run: 90 days back
    expect((await db.query(`SELECT itsm_enabled FROM tenants WHERE id=$1`, [TENANT])).rows[0].itsm_enabled).toBe(true);

    const f2 = fakeSdp([[req(20871, 'Firewall kural düzeltmesi (güncellendi)', 'murat.aydin@beta.example.com', { status: { name: 'Kapalı' } })]]);
    const r2 = await runItsmSync(db, createItsmClient({ baseUrl: 'https://sd', apiKey: 'k', fetchImpl: f2.impl }), TENANT);
    expect(Date.now() - new Date(r2.since).getTime()).toBeLessThan(60 * 60_000); // second run: just before the last one
    const rows = (await db.query(`SELECT id, title, status FROM itsm_tickets ORDER BY id`)).rows;
    expect(rows).toEqual([{ id: '20871', title: 'Firewall kural düzeltmesi (güncellendi)', status: 'Kapalı' }, { id: '20872', title: 'Başkasının işi', status: 'Açık' }]);
  });

  it('records a failure and keeps the old tickets', async () => {
    const bad = createItsmClient({ baseUrl: 'https://sd', apiKey: 'k', fetchImpl: fakeSdp([[]], { code: 4000 }).impl });
    const r = await runItsmSync(db, bad, TENANT);
    expect(r.error).toContain('4000');
    expect((await db.query(`SELECT last_status FROM job_runs WHERE name='itsm-sync'`)).rows[0].last_status).toBe('error');
    expect((await db.query(`SELECT count(*)::int AS n FROM itsm_tickets`)).rows[0].n).toBe(2);
  });

  it('offers a person only the tickets assigned to their e-mail, and links by "#number"', async () => {
    const cands = await candidatesFor(db, emp, (await db.query(`SELECT project_id FROM employee_projects WHERE employee_id=$1`, [emp])).rows.map((x) => x.project_id));
    expect(cands.filter((c) => c.kind === 'itsm').map((c) => c.id)).toEqual(['20871']); // not 20872
    const link = (text: string) => linkRow({ description: text, taskHint: null, ticketHint: null, sourceText: text }, cands);
    expect(link('firewall işi #20871 için 2 saat')).toMatchObject({ kind: 'itsm', id: '20871', via: 'explicit-id' });
    expect(link('talep 20871 kapatıldı')).toMatchObject({ id: '20871' });
    expect(link('#20872 başkasının')).toMatchObject({ id: null }); // never links a ticket that is not theirs
  });
});
