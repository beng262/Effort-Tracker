import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import { buildApp } from '../src/server/app.js';

describe('customers and quick projects', () => {
  let server: Server; let base: string; let cookie: string; let db: any;
  const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  beforeAll(async () => {
    db = await testDb();
    server = buildApp({ db, ai: {} as any, blob: {} as any, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-15' } as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e@x.com', name: 'Emp', role: 'Employee', tenant: 'tenant-a' }) });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    await db.query(`INSERT INTO itsm_tickets (tenant_id,id,title,customer,status) VALUES ('tenant-a','9','x','Birch Holding','Açık'),('tenant-a','10','y','birch holding','Açık')`);
  });
  afterAll(() => { server.close(); });

  it('lists ITSM customers once, and adds a missing one without duplicating', async () => {
    let list = await (await call('GET', '/api/customers')).json();
    expect(list.filter((c: any) => /birch/i.test(c.name))).toHaveLength(1);
    expect(list[0].source).toBe('itsm');
    const same = await (await call('POST', '/api/customers', { name: '  BIRCH  holding ' })).json();
    expect(same.name).toBe('Birch Holding'); // already there: the ITSM spelling wins
    const added = await call('POST', '/api/customers', { name: 'Yeni Müşteri A.Ş.' });
    expect(added.status).toBe(201);
    list = await (await call('GET', '/api/customers')).json();
    expect(list.find((c: any) => c.name === 'Yeni Müşteri A.Ş.')).toMatchObject({ source: 'manual' });
    expect((await call('POST', '/api/customers', { name: 'x' })).status).toBe(400);
  });

  it('lets an employee add a project while entering effort; it lands in their list', async () => {
    const r = await call('POST', '/api/projects/quick', { name: 'Hızlı Proje', customer: 'Başka Müşteri' });
    expect(r.status).toBe(201);
    const mine = await (await call('GET', '/api/projects')).json();
    expect(mine.map((p: any) => p.name)).toContain('Hızlı Proje');
    expect((await call('POST', '/api/projects/quick', { name: 'hızlı proje' })).status).toBe(409);
    const list = await (await call('GET', '/api/customers')).json();
    expect(list.map((c: any) => c.name)).toContain('Başka Müşteri'); // a customer typed on a project is remembered
  });
});
