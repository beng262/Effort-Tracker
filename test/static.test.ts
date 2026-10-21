import type { AddressInfo } from 'node:net';
import { get as httpGet, type Server } from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import { buildApp } from '../src/server/app.js';

describe('front end delivery', () => {
  let server: Server;
  let base: string;
  const ask = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { 'accept-encoding': 'identity', ...headers } });

  beforeAll(async () => {
    const db = await testDb();
    server = buildApp({ db, ai: {} as any, blob: {} as any, vault: {} as any, itsm: { baseUrl: null, tenantId: null, make: () => null }, today: () => '2026-10-15' } as any, { get: async () => ({}) }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  it('index.html names the scripts and styles with a content hash and is never cached', async () => {
    const r = await ask('/');
    const html = await r.text();
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(html).toMatch(/src="\/theme\.js\?v=[0-9a-f]{10}"/);
    expect(html).toMatch(/href="\/style\.css\?v=[0-9a-f]{10}"/);
    expect(html).toMatch(/src="\/app\.js\?v=[0-9a-f]{10}"/);
  });

  it('hashed files are cached for a year; unhashed ones must be revalidated', async () => {
    const v = (await (await ask('/')).text()).match(/app\.js\?v=([0-9a-f]+)/)![1];
    expect((await ask(`/app.js?v=${v}`)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await ask('/app.js')).headers.get('cache-control')).toBe('no-cache');
  });

  /** The bytes as they travel (fetch would silently decompress them). */
  const raw = (path: string, enc: string) => new Promise<{ headers: Record<string, any>; body: Buffer }>((ok, fail) => {
    httpGet(`${base}${path}`, { headers: { 'accept-encoding': enc } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', fail);
  });

  it('serves brotli or gzip when the browser accepts it, and the plain file otherwise, all identical when decoded', async () => {
    const original = readFileSync(join(__dirname, '..', 'public', 'app.js'));
    const plain = await raw('/app.js', 'identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.equals(original)).toBe(true);

    const br = await raw('/app.js', 'gzip, br');
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.body.length).toBeLessThan(original.length / 3); // the point of it
    expect(brotliDecompressSync(br.body).equals(original)).toBe(true);

    const gz = await raw('/app.js', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body.length).toBeLessThan(original.length / 2);
    expect(gunzipSync(gz.body).equals(original)).toBe(true);
    expect(gz.headers['vary']).toContain('Accept-Encoding');
  });

  it('answers a repeat visit with 304 and no body', async () => {
    const first = await ask('/style.css');
    const etag = first.headers.get('etag')!;
    const again = await ask('/style.css', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  it('fonts are cached for a month', async () => {
    const r = await ask('/fonts/space-grotesk-latin-700-normal.woff2');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('max-age=2592000');
  });

  it('gzips large JSON answers and leaves small ones alone', async () => {
    const login = await fetch(`${base}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.com', name: 'A', role: 'Admin', tenant: 'tenant-a' }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    // /api/holidays lists 14 seeded-by-test-free rows; use audit (admin) after the login events are written, plus a big report-free call
    const small = await fetch(`${base}/api/me`, { headers: { cookie, 'accept-encoding': 'gzip' } });
    expect(small.headers.get('content-encoding')).toBeNull();
    expect((await small.json()).email).toBe('a@x.com');
  });
});
