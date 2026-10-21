import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import { buildApp } from '../src/server/app.js';
import { cleanFileName } from '../src/server/projectFiles.js';

describe('project files', () => {
  let server: Server; let base: string; let db: any; let projectId: string; let otherProject: string;
  const store = new Map<string, Buffer>();
  const blob = { put: async (p: string, d: Buffer) => { store.set(p, d); }, get: async (p: string) => store.get(p) ?? Buffer.alloc(0), remove: async (p: string) => { store.delete(p); } };

  class Person {
    cookie = '';
    constructor(public email: string, public name: string, public role = 'Employee') {}
    async login() {
      const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email, name: this.name, role: this.role, tenant: 'tenant-a' }) });
      this.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
      return this;
    }
    call(method: string, path: string, body?: unknown) {
      return fetch(`${base}${path}`, { method, headers: { cookie: this.cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    }
    upload(path: string, files: { name: string; data: Buffer }[], note?: string) {
      const f = new FormData();
      for (const x of files) f.append('file', new Blob([x.data]), x.name);
      if (note) f.set('note', note);
      return fetch(`${base}${path}`, { method: 'POST', headers: { cookie: this.cookie }, body: f });
    }
  }
  let ayse: Person; let mehmet: Person; let outsider: Person; let pm: Person; let admin: Person;

  beforeAll(async () => {
    db = await testDb();
    server = buildApp({ db, ai: {} as any, blob, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-21' } as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ayse = await new Person('ayse@x.com', 'Ayşe').login();
    mehmet = await new Person('mehmet@x.com', 'Mehmet').login();
    outsider = await new Person('disarida@x.com', 'Dışarıda').login();
    pm = await new Person('pm@x.com', 'Proje Yöneticisi', 'PM').login();
    admin = await new Person('admin@x.com', 'Yönetici', 'Admin').login();
    const pmId = (await db.query(`SELECT id FROM employees WHERE email='pm@x.com'`)).rows[0].id;
    projectId = (await db.query(`INSERT INTO projects (name, created_by) VALUES ('Lisans Yönetimi',$1) RETURNING id`, [pmId])).rows[0].id;
    otherProject = (await db.query(`INSERT INTO projects (name, created_by) VALUES ('Başka Proje',$1) RETURNING id`, [pmId])).rows[0].id;
    for (const e of ['ayse@x.com', 'mehmet@x.com']) await db.query(`INSERT INTO employee_projects SELECT id, $2::uuid FROM employees WHERE email=$1`, [e, projectId]);
  });
  afterAll(() => { server.close(); });

  it('cleans a file name: no path, no control characters, no leading dots, the extension survives', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\x\\Kapsam Dokümanı.pdf')).toBe('Kapsam Dokümanı.pdf');
    expect(cleanFileName('.env')).toBe('env');
    expect(cleanFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(cleanFileName('   ')).toBe('dosya');
    expect(cleanFileName('x'.repeat(300) + '.xlsx').endsWith('.xlsx')).toBe(true);
    expect(cleanFileName('x'.repeat(300) + '.xlsx').length).toBeLessThanOrEqual(200);
  });

  it('a team member adds several files at once; project managers and the team see them, an outsider does not', async () => {
    const r = await ayse.upload(`/api/projects/${projectId}/files`, [{ name: 'Kapsam Dokümanı.pdf', data: Buffer.from('kapsam v1') }, { name: 'Teklif.xlsx', data: Buffer.from('teklif') }], 'ilk sürüm');
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.added.map((x: any) => x.name).sort()).toEqual(['Kapsam Dokümanı.pdf', 'Teklif.xlsx']);
    expect(body.skipped).toEqual([]);
    for (const who of [ayse, mehmet, pm, admin]) {
      const list = await (await who.call('GET', `/api/projects/${projectId}/files`)).json();
      expect(list.map((f: any) => f.name).sort()).toEqual(['Kapsam Dokümanı.pdf', 'Teklif.xlsx']);
    }
    const list = await (await pm.call('GET', `/api/projects/${projectId}/files`)).json();
    expect(list[0]).toMatchObject({ uploader: 'Ayşe', note: 'ilk sürüm', size: expect.any(Number) });
    expect((await outsider.call('GET', `/api/projects/${projectId}/files`)).status).toBe(403);
    expect((await outsider.upload(`/api/projects/${projectId}/files`, [{ name: 'x.txt', data: Buffer.from('x') }])).status).toBe(403);
    expect((await ayse.call('GET', `/api/projects/${otherProject}/files`)).status).toBe(403); // a project she is not on
    expect((await new Person('x@x.com', 'x').call('GET', `/api/projects/${projectId}/files`)).status).toBe(401); // not signed in
    expect([...store.keys()].every((k) => k.startsWith(`projects/${projectId}/`))).toBe(true);
  });

  it('downloads the exact bytes, always as an attachment', async () => {
    const list = await (await ayse.call('GET', `/api/projects/${projectId}/files`)).json();
    const f = list.find((x: any) => x.name === 'Kapsam Dokümanı.pdf');
    const r = await mehmet.call('GET', `/api/projects/${projectId}/files/${f.id}/download`);
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('kapsam v1');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename=".*"; filename\*=UTF-8''Kapsam%20Dok%C3%BCman%C4%B1\.pdf$/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await outsider.call('GET', `/api/projects/${projectId}/files/${f.id}/download`)).status).toBe(403);
    expect((await ayse.call('GET', `/api/projects/${otherProject}/files/${f.id}/download`)).status).toBe(403);
    expect((await pm.call('GET', `/api/projects/${otherProject}/files/${f.id}/download`)).status).toBe(404); // right person, wrong project
  });

  it('does not store the same bytes twice, skips an empty file, refuses an oversized one, and keeps going with the others', async () => {
    const r = await mehmet.upload(`/api/projects/${projectId}/files`, [
      { name: 'Aynı içerik.pdf', data: Buffer.from('kapsam v1') },        // same bytes as the first file
      { name: 'Boş.txt', data: Buffer.alloc(0) },
      { name: 'Toplantı notu.txt', data: Buffer.from('notlar') },
    ]);
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.added.map((x: any) => x.name)).toEqual(['Toplantı notu.txt']);
    expect(body.skipped.map((x: any) => x.name).sort()).toEqual(['Aynı içerik.pdf', 'Boş.txt']);
    const only = await mehmet.upload(`/api/projects/${projectId}/files`, [{ name: 'Aynı içerik.pdf', data: Buffer.from('kapsam v1') }]);
    expect(only.status).toBe(200);
    expect((await only.json()).skipped[0].reason).toContain('Kapsam Dokümanı.pdf');
    const big = await mehmet.upload(`/api/projects/${projectId}/files`, [{ name: 'Büyük.bin', data: Buffer.alloc(2 * 1024 * 1024, 1) }]);
    expect(big.status).toBe(400);
    expect((await big.json()).error).toContain('1 MB');
  });

  it('only the uploader, the project creator or an admin can delete; the stored bytes go too', async () => {
    const up = await ayse.upload(`/api/projects/${projectId}/files`, [{ name: 'Silinecek.txt', data: Buffer.from('gecici') }, { name: 'Pm silecek.txt', data: Buffer.from('gecici 2') }, { name: 'Admin silecek.txt', data: Buffer.from('gecici 3') }]);
    const ids = Object.fromEntries((await up.json()).added.map((x: any) => [x.name, x.id]));
    expect((await mehmet.call('DELETE', `/api/projects/${projectId}/files/${ids['Silinecek.txt']}`)).status).toBe(403); // a teammate, not the uploader
    expect((await outsider.call('DELETE', `/api/projects/${projectId}/files/${ids['Silinecek.txt']}`)).status).toBe(403);
    const before = store.size;
    expect((await ayse.call('DELETE', `/api/projects/${projectId}/files/${ids['Silinecek.txt']}`)).status).toBe(200);
    expect(store.size).toBe(before - 1);
    expect((await pm.call('DELETE', `/api/projects/${projectId}/files/${ids['Pm silecek.txt']}`)).status).toBe(200); // created the project
    expect((await admin.call('DELETE', `/api/projects/${projectId}/files/${ids['Admin silecek.txt']}`)).status).toBe(200);
    const list = await (await ayse.call('GET', `/api/projects/${projectId}/files`)).json();
    expect(list.map((f: any) => f.name)).not.toContain('Silinecek.txt');
    expect((await ayse.call('GET', `/api/projects/${projectId}/files/${ids['Silinecek.txt']}/download`)).status).toBe(404);
    expect((await ayse.call('DELETE', `/api/projects/${projectId}/files/${ids['Silinecek.txt']}`)).status).toBe(404);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action='project_file_delete'`)).rows[0].n).toBe(3);
    // a deleted file can be added again
    expect((await ayse.upload(`/api/projects/${projectId}/files`, [{ name: 'Silinecek.txt', data: Buffer.from('gecici') }])).status).toBe(201);
  });

  it('tells each person whether they may delete a file', async () => {
    const asAyse = await (await ayse.call('GET', `/api/projects/${projectId}/files`)).json();
    const asMehmet = await (await mehmet.call('GET', `/api/projects/${projectId}/files`)).json();
    const first = asAyse.find((f: any) => f.name === 'Kapsam Dokümanı.pdf');
    expect(first.canDelete).toBe(true);
    expect(asMehmet.find((f: any) => f.name === 'Kapsam Dokümanı.pdf').canDelete).toBe(false);
    expect((await (await pm.call('GET', `/api/projects/${projectId}/files`)).json()).every((f: any) => f.canDelete)).toBe(true);
  });
});
