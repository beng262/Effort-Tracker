import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import type { Db } from '../src/server/db.js';
import { buildApp } from '../src/server/app.js';
import { createItsmClient, forgetItsmKey } from '../src/server/itsm.js';
import { createVault, memoryVault } from '../src/server/secrets.js';

const req = (id: number, subject: string, tech: string | null) => ({
  id: String(id), display_id: String(id), subject, status: { name: 'Açık' }, technician: tech ? { email_id: tech } : null,
  created_time: { value: String(Date.UTC(2026, 9, 1)) }, account: { name: 'Acme' },
});

/* ---------- Key Vault through the managed identity ---------- */

describe('Key Vault client', () => {
  const env = { IDENTITY_ENDPOINT: 'http://169.254.0.1/msi/token', IDENTITY_HEADER: 'hdr' };
  const make = (handler: (url: string, init: any) => Response) => {
    const calls: { url: string; init: any }[] = [];
    const impl = (async (url: string, init: any) => { calls.push({ url, init }); return handler(url, init); }) as unknown as typeof fetch;
    return { calls, vault: createVault({ vaultName: 'kv-x', fetchImpl: impl, env }) };
  };
  const token = () => new Response(JSON.stringify({ access_token: 'TOK', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));

  it('asks the managed identity for a token, then writes and reads the secret', async () => {
    const { calls, vault } = make((url, init) => {
      if (url.includes('/msi/token')) return token();
      return init?.method === 'PUT' ? new Response('{}') : new Response(JSON.stringify({ value: 'S3CRET-VALUE', attributes: { updated: 1791888226 } }));
    });
    await vault.set('itsm-api-key', 'S3CRET-VALUE');
    const got = await vault.get('itsm-api-key');
    expect(got).toEqual({ value: 'S3CRET-VALUE', updatedAt: new Date(1791888226 * 1000).toISOString() });
    expect(calls[0].url).toContain('resource=https%3A%2F%2Fvault.azure.net');
    expect(calls[0].init.headers['X-IDENTITY-HEADER']).toBe('hdr');
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(put.url).toBe('https://kv-x.vault.azure.net/secrets/itsm-api-key?api-version=7.4');
    expect(put.init.headers.authorization).toBe('Bearer TOK');
    expect(JSON.parse(put.init.body)).toEqual({ value: 'S3CRET-VALUE' });
    expect(calls.filter((c) => c.url.includes('/msi/token'))).toHaveLength(1); // the token is reused
  });

  it('a missing secret is null, and a refusal never echoes the secret', async () => {
    const missing = make((url) => (url.includes('/msi/token') ? token() : new Response('{}', { status: 404 })));
    expect(await missing.vault.get('itsm-api-key')).toBeNull();
    const denied = make((url) => (url.includes('/msi/token') ? token() : new Response(JSON.stringify({ error: { message: 'Forbidden: access policy' } }), { status: 403 })));
    const err = await denied.vault.set('itsm-api-key', 'TOP-SECRET-123').catch((e) => e as Error);
    expect(err.message).toContain('403');
    expect(err.message).not.toContain('TOP-SECRET-123');
  });

  it('outside Azure (no managed identity) it says so instead of guessing', async () => {
    const v = createVault({ vaultName: 'kv-x', env: {}, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    await expect(v.get('itsm-api-key')).rejects.toThrow('managed identity');
  });
});

/* ---------- the Yönetim endpoints ---------- */

describe('ITSM key endpoints', () => {
  let server: Server;
  let base: string;
  let db: Db;
  const vault = memoryVault();
  let accept = true;
  const probes: string[] = [];

  const sdpFor = (key: string) => createItsmClient({
    baseUrl: 'https://support.example.com', apiKey: key,
    fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
      probes.push(init.headers.authtoken);
      return accept
        ? new Response(JSON.stringify({ response_status: { status_code: 2000 }, requests: [req(1, 'Eski', 'murat@x.com')], list_info: { has_more_rows: false } }))
        : new Response(JSON.stringify({ response_status: { status_code: 4000, messages: [{ message: `Invalid key ${key}` }] } }));
    }) as unknown as typeof fetch,
  });

  class C {
    cookie = '';
    async login(email: string, role?: string) {
      const r = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email, role, tenant: 'tenant-a' }) });
      this.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
      return this;
    }
    async call(method: string, path: string, body?: unknown) {
      const r = await fetch(`${base}${path}`, { method, headers: { cookie: this.cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, text, body: json };
    }
  }
  let admin: C; let pm: C; let emp: C;

  beforeAll(async () => {
    db = await testDb();
    const ctx = {
      db, ai: {} as any, blob: {} as any, vault, today: () => '2026-10-13',
      itsm: { baseUrl: 'https://support.example.com', tenantId: 'tenant-a', make: sdpFor },
    };
    server = buildApp(ctx as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = await new C().login('admin@x.com', 'Admin');
    pm = await new C().login('pm@x.com', 'PM');
    emp = await new C().login('emp@x.com');
    forgetItsmKey();
  });
  afterAll(() => { server.close(); });

  it('only an admin can see the connection or save a key', async () => {
    for (const c of [pm, emp]) {
      expect((await c.call('GET', '/api/itsm')).status).toBe(403);
      expect((await c.call('POST', '/api/itsm/key', { key: 'abcdefgh12345' })).status).toBe(403);
      expect((await c.call('POST', '/api/itsm/sync')).status).toBe(403);
    }
    expect((await admin.call('GET', '/api/itsm')).body).toMatchObject({ baseUrl: 'https://support.example.com', keySet: false });
  });

  it('refuses malformed keys and keys ITSM rejects, and writes nothing to the vault', async () => {
    expect((await admin.call('POST', '/api/itsm/key', { key: 'short' })).status).toBe(400);
    expect((await admin.call('POST', '/api/itsm/key', { key: 'has a space in it' })).status).toBe(400);
    accept = false;
    const r = await admin.call('POST', '/api/itsm/key', { key: 'WRONG-KEY-123456' });
    expect(r.status).toBe(400);
    expect(r.text).toContain('kabul edilmedi');
    expect(r.text).not.toContain('WRONG-KEY-123456'); // not even echoed back inside an error
    expect(await vault.get('itsm-api-key')).toBeNull();
    expect((await admin.call('GET', '/api/itsm')).body.keySet).toBe(false);
  });

  it('tries the key first, then stores it in the vault only, never returning it', async () => {
    accept = true; probes.length = 0;
    const r = await admin.call('POST', '/api/itsm/key', { key: 'GOOD-KEY-0987654321' });
    expect(r.body).toEqual({ saved: true });
    expect(r.text).not.toContain('GOOD-KEY-0987654321');
    expect(probes[0]).toBe('GOOD-KEY-0987654321'); // verified before it was saved
    expect((await vault.get('itsm-api-key'))?.value).toBe('GOOD-KEY-0987654321');

    const info = await admin.call('GET', '/api/itsm');
    expect(info.body).toMatchObject({ keySet: true });
    expect(info.text).not.toContain('GOOD-KEY');
    expect((await admin.call('GET', '/api/status')).body.itsm.configured).toBe(true);

    // The key is in no table, and the audit trail records the event without the value.
    const dump = JSON.stringify((await db.query('SELECT * FROM audit_events')).rows) + JSON.stringify((await db.query('SELECT * FROM job_runs')).rows);
    expect(dump).toContain('itsm_key_set');
    expect(dump).not.toContain('GOOD-KEY');
  });

  it('reads tickets with the saved key straight away', async () => {
    await new Promise((ok) => setTimeout(ok, 300)); // the first sync runs in the background
    const r = await admin.call('POST', '/api/itsm/sync');
    expect(r.body).toMatchObject({ tickets: 1 });
    expect((await db.query('SELECT id FROM itsm_tickets')).rows).toEqual([{ id: '1' }]);
  });
});
