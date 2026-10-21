import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync, gzip } from 'node:zlib';
import express, { type Express, type Request, type Response } from 'express';

interface Asset { type: string; raw: Buffer; br: Buffer; gz: Buffer; etag: string }

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };

function prepare(type: string, body: Buffer): Asset {
  return {
    type, raw: body,
    br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    gz: gzipSync(body, { level: 9 }),
    etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
  };
}

function send(req: Request, res: Response, a: Asset, cache: string): void {
  res.setHeader('Content-Type', a.type);
  res.setHeader('Cache-Control', cache);
  res.setHeader('ETag', a.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === a.etag) { res.status(304).end(); return; }
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accept)) { res.setHeader('Content-Encoding', 'br'); res.end(a.br); }
  else if (/\bgzip\b/.test(accept)) { res.setHeader('Content-Encoding', 'gzip'); res.end(a.gz); }
  else res.end(a.raw);
}

/**
 * The front end. The three files that change are read once, compressed once (brotli and gzip) and served from memory.
 * index.html names them with a content hash (?v=…), so they can be cached for a year and a new deploy is picked up at once.
 * Fonts never change and are cached for a month.
 */
export function serveFront(app: Express, publicDir: string): void {
  const read = (f: string) => readFileSync(join(publicDir, f));
  const files = { '/app.js': prepare(TYPES['.js'], read('app.js')), '/style.css': prepare(TYPES['.css'], read('style.css')), '/theme.js': prepare(TYPES['.js'], read('theme.js')) };
  const version = createHash('sha1').update(Object.values(files).map((f) => f.etag).join('')).digest('hex').slice(0, 10);

  let html = read('index.html').toString('utf8');
  for (const path of Object.keys(files)) html = html.replace(`"${path}"`, `"${path}?v=${version}"`);
  const index = prepare(TYPES['.html'], Buffer.from(html));

  app.get(['/', '/index.html'], (req, res) => send(req, res, index, 'no-cache'));
  for (const [path, asset] of Object.entries(files)) {
    app.get(path, (req, res) => send(req, res, asset, req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache'));
  }
  const favicon = prepare('image/svg+xml', read('favicon.svg'));
  app.get('/favicon.svg', (req, res) => send(req, res, favicon, 'public, max-age=86400'));
  app.use('/fonts', express.static(join(publicDir, 'fonts'), { maxAge: '30d', immutable: true }));
}

/** gzip big JSON answers (lists, reports): they are mostly repeated keys and shrink to a fifth. */
export function compressJson(req: Request, res: Response, next: () => void): void {
  const original = res.json.bind(res);
  res.json = (body: unknown) => {
    const text = JSON.stringify(body);
    if (text.length < 1024 || !/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) || res.headersSent) return original(body);
    gzip(text, (err, buf) => {
      if (err || res.headersSent) { if (!res.headersSent) res.type('json').send(text); return; }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.type('json').send(buf);
    });
    return res;
  };
  next();
}
