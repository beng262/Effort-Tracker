import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import { buildApp } from '../src/server/app.js';
import type { Db } from '../src/server/db.js';
import { discoverPlans, type Graph } from '../src/server/graph.js';

/** A tenant with three groups: two with plans (one has two), one that Graph refuses to read. */
const fakeGraph = (): Graph => ({
  async get(_t, path) {
    if (path.startsWith('/groups?')) {
      return { value: [{ id: 'g1', displayName: 'BETA' }, { id: 'g2', displayName: 'Takip' }, { id: 'g3', displayName: 'Gizli grup' }] };
    }
    if (path === '/groups/g1/planner/plans') return { value: [{ id: 'planA', title: 'Cedar Corp ' }, { id: 'planB', title: 'Dogwood Corp' }] };
    if (path === '/groups/g2/planner/plans') return { value: [{ id: 'planC', title: 'Birch' }] };
    if (path === '/groups/g3/planner/plans') throw new Error('Graph 403 https://graph.microsoft.com/v1.0/groups/g3/planner/plans: Forbidden');
    if (path.endsWith('/buckets')) return { value: [] };
    if (path.endsWith('/tasks')) return { value: [] };
    return { title: 'plan' };
  },
});

describe('plan discovery', () => {
  it('lists every plan of every readable group and says which groups could not be read', async () => {
    const d = await discoverPlans(fakeGraph(), 't');
    expect(d.groups).toBe(3);
    expect(d.plans.map((p) => p.id)).toEqual(['planA', 'planB', 'planC']);
    expect(d.skipped).toHaveLength(1);
    expect(d.skipped[0]).toMatchObject({ group: 'Gizli grup' });
    expect(d.skipped[0].reason).toContain('403');
    expect(d.skipped[0].reason).not.toContain('graph.microsoft.com'); // no URLs in what is shown
  });
});

describe('all plans as projects', () => {
  let server: Server;
  let base: string;
  let db: Db;
  let cookie = '';
  let memberCookie = '';

  const call = async (c: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { cookie: c, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const login = async (email: string, role?: string) => {
    const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email, role, tenant: 'tenant-a' }) });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };

  beforeAll(async () => {
    db = await testDb();
    const ctx = { db, ai: {} as any, blob: {} as any, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-13' };
    server = buildApp(ctx as any, fakeGraph()).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cookie = await login('cansu@x.com', 'PM');
    memberCookie = await login('emp@x.com');
  });
  afterAll(() => { server.close(); });

  it('the lookup returns the plans with who holds them, plus the scan report', async () => {
    const r = (await call(cookie, 'GET', '/api/planner/plans?tenantId=tenant-a')).body;
    expect(r.plans.map((p: any) => [p.id, p.project])).toEqual([['planA', null], ['planB', null], ['planC', null]]);
    expect(r).toMatchObject({ groups: 3 });
    expect(r.skipped[0].group).toBe('Gizli grup');
  });

  it('creates one project per unlinked plan, skips linked ones, and is safe to press twice', async () => {
    await call(cookie, 'POST', '/api/projects', { name: 'Elle açılan', plans: [{ tenantId: 'tenant-a', planId: 'planB', title: 'Dogwood Corp' }] });
    const r = (await call(cookie, 'POST', '/api/projects/from-plans', { tenantId: 'tenant-a' })).body;
    expect(r).toMatchObject({ created: 2, alreadyLinked: 1, skippedGroups: 1 });
    expect(r.names.sort()).toEqual(['Birch', 'Cedar Corp']); // titles are trimmed
    const names = (await call(cookie, 'GET', '/api/projects')).body.map((p: any) => p.name).sort();
    expect(names).toEqual(['Birch', 'Cedar Corp', 'Elle açılan']);
    expect((await call(cookie, 'POST', '/api/projects/from-plans', { tenantId: 'tenant-a' })).body).toMatchObject({ created: 0, alreadyLinked: 3 });
    expect((await call(cookie, 'GET', '/api/planner/plans?tenantId=tenant-a')).body.plans.map((p: any) => p.project)).toEqual(['Cedar Corp', 'Elle açılan', 'Birch']);
  });

  it('can be limited to chosen plans, and employees cannot use it', async () => {
    await call(cookie, 'DELETE', `/api/projects/${(await call(cookie, 'GET', '/api/projects')).body.find((p: any) => p.name === 'Birch').id}`); // frees planC
    expect((await call(cookie, 'POST', '/api/projects/from-plans', { tenantId: 'tenant-a', planIds: ['planC'] })).body).toMatchObject({ created: 1 });
    expect((await call(memberCookie, 'POST', '/api/projects/from-plans', { tenantId: 'tenant-a' })).status).toBe(403);
    expect((await call(memberCookie, 'GET', '/api/planner/plans?tenantId=tenant-a')).status).toBe(403);
  });
});
