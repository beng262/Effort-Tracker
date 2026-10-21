import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

export type Role = 'Employee' | 'PM' | 'Admin';
export interface User { employeeId: string; name: string; email: string; role: Role; dayHours: number }

const COOKIE = 'efor_session';
const TTL_MS = 12 * 3600 * 1000;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (data: string) => createHmac('sha256', config.SESSION_SECRET).update(data).digest('base64url');

export function sealToken(payload: object, ttlMs = TTL_MS): string {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return `${body}.${sign(body)}`;
}

export function openToken<T>(token: string | undefined): (T & { exp: number }) | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res: Response, name: string, value: string, maxAgeMs: number) {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
}

export const clearCookie = (res: Response, name: string) => setCookie(res, name, '', 0);

export function startSession(res: Response, user: User) {
  setCookie(res, COOKIE, sealToken({ u: user }), TTL_MS);
}
export function endSession(res: Response) { clearCookie(res, COOKIE); }

declare module 'express-serve-static-core' { interface Request { user?: User } }

export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const t = openToken<{ u: User }>(parseCookies(req)[COOKIE]);
  if (t) req.user = t.u;
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return void res.status(401).json({ error: 'Oturum gerekli' });
  next();
}

const RANK: Record<Role, number> = { Employee: 0, PM: 1, Admin: 2 };
export const requireRole = (min: Role) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return void res.status(401).json({ error: 'Oturum gerekli' });
  if (RANK[req.user.role] < RANK[min]) return void res.status(403).json({ error: 'Bu işlem için yetkiniz yok' });
  next();
};
export const atLeast = (u: User, min: Role) => RANK[u.role] >= RANK[min];
