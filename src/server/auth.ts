import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { allowedTenants, config } from './config.js';
import type { Db } from './db.js';
import { audit } from './access.js';
import { clearCookie, endSession, openToken, parseCookies, sealToken, setCookie, startSession, type Role, type User } from './session.js';

const AUTHORITY = 'https://login.microsoftonline.com/organizations';
const jwks = createRemoteJWKSet(new URL(`${AUTHORITY}/discovery/v2.0/keys`));
const RANK: Record<string, number> = { Employee: 0, PM: 1, Admin: 2 };

export interface EntraClaims { tid: string; oid: string; email: string; name: string; roles: string[] }

/**
 * Map a verified Entra identity to an employee. The tenant must be on the allowlist
 * (multi-tenant registration alone would let any tenant in). One employee can hold one
 * identity per tenant, matched by (tenant, oid) or by (tenant, email) on first sign-in.
 */
export async function resolveEmployee(db: Db, c: EntraClaims): Promise<User> {
  const tenant = allowedTenants().find((t) => t.id === c.tid.toLowerCase())
    ?? (config.AUTH_MODE === 'dev' && c.tid === 'dev-tenant' ? { id: 'dev-tenant', name: 'Dev', domain: 'example.com' } : undefined);
  if (!tenant) throw new Error('Bu kiracı (tenant) için erişim yok');
  const email = c.email.toLowerCase();

  return db.tx(async (t) => {
    await t.query(`INSERT INTO tenants (id, name, domain) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [tenant.id, tenant.name, tenant.domain]);
    let idRow = (await t.query(`SELECT employee_id FROM identities WHERE tenant_id=$1 AND entra_oid=$2`, [tenant.id, c.oid])).rows[0];
    if (!idRow) {
      idRow = (await t.query(`SELECT employee_id FROM identities WHERE tenant_id=$1 AND lower(email)=$2`, [tenant.id, email])).rows[0];
      if (idRow) {
        await t.query(`UPDATE identities SET entra_oid=$1 WHERE tenant_id=$2 AND lower(email)=$3`, [c.oid, tenant.id, email]);
        // First sign-in of a seeded person: the real display name replaces the one guessed from the e-mail.
        if (c.name) await t.query(`UPDATE employees SET name=$1 WHERE id=$2`, [c.name, idRow.employee_id]);
      }
    }
    let employeeId: string;
    if (idRow) employeeId = idRow.employee_id;
    else {
      // A person already known by this email in the other tenant keeps one employee record.
      const byEmail = (await t.query(`SELECT id FROM employees WHERE lower(email)=$1`, [email])).rows[0];
      employeeId = byEmail?.id ?? (await t.query(`INSERT INTO employees (name, email, day_hours) VALUES ($1,$2,$3) RETURNING id`, [c.name || email, email, config.DEFAULT_DAY_HOURS])).rows[0].id;
      await t.query(`INSERT INTO identities (employee_id, tenant_id, email, entra_oid) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, email) DO UPDATE SET entra_oid = EXCLUDED.entra_oid`, [employeeId, tenant.id, email, c.oid]);
    }
    // App roles from Entra are authoritative when present.
    const best = c.roles.filter((r) => r in RANK).sort((a, b) => RANK[b] - RANK[a])[0] as Role | undefined;
    if (best) await t.query(`UPDATE employees SET role=$1 WHERE id=$2`, [best, employeeId]);
    const e = (await t.query(`SELECT id, name, email, role, day_hours, active FROM employees WHERE id=$1`, [employeeId])).rows[0];
    if (!e.active) throw new Error('Hesap pasif');
    await audit(t, employeeId, 'login', tenant.id);
    return { employeeId: e.id, name: e.name, email: e.email, role: e.role, dayHours: e.day_hours };
  });
}

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');

export function authRouter(db: Db): Router {
  const r = Router();

  r.get('/auth/mode', (_req, res) => res.json({ mode: config.AUTH_MODE }));

  r.get('/auth/login', (_req, res) => {
    if (config.AUTH_MODE === 'dev') return void res.redirect('/?dev=1');
    if (!config.ENTRA_CLIENT_ID) return void res.status(500).send('ENTRA_CLIENT_ID is not set');
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    setCookie(res, 'efor_oidc', sealToken({ verifier, state, nonce }, 10 * 60 * 1000), 10 * 60 * 1000);
    const q = new URLSearchParams({
      client_id: config.ENTRA_CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${config.PUBLIC_URL}/auth/callback`,
      response_mode: 'query',
      scope: 'openid profile email',
      state, nonce,
      code_challenge: sha(verifier),
      code_challenge_method: 'S256',
    });
    res.redirect(`${AUTHORITY}/oauth2/v2.0/authorize?${q}`);
  });

  r.get('/auth/callback', async (req, res) => {
    // Return from the admin-consent page: there is no sign-in code, only the consent result.
    if (req.query.admin_consent !== undefined) {
      const ok = String(req.query.admin_consent).toLowerCase() === 'true';
      const msg = ok ? 'Yönetici onayı verildi. Şimdi giriş yapabilirsiniz.' : `Yönetici onayı verilmedi: ${String(req.query.error_description ?? req.query.error ?? 'bilinmeyen neden').slice(0, 300)}`;
      return void res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><title>Effort Tracker</title><body style="font-family:system-ui;max-width:480px;margin:60px auto"><p>${msg.replace(/[<>&"]/g, '')}</p><p><a href="/auth/login">Giriş yap</a></p></body>`);
    }
    try {
      const saved = openToken<{ verifier: string; state: string; nonce: string }>(parseCookies(req).efor_oidc);
      clearCookie(res, 'efor_oidc');
      if (!saved || req.query.state !== saved.state || typeof req.query.code !== 'string') throw new Error('Geçersiz oturum açma isteği');
      const tok = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.ENTRA_CLIENT_ID!, client_secret: config.ENTRA_CLIENT_SECRET!,
          grant_type: 'authorization_code', code: req.query.code,
          redirect_uri: `${config.PUBLIC_URL}/auth/callback`, code_verifier: saved.verifier,
        }),
      });
      const body: any = await tok.json();
      if (!tok.ok || !body.id_token) throw new Error('Token alınamadı');
      // The issuer carries the tenant id; verify it against the allowlist before trusting the token.
      const unverified = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString());
      const tid = String(unverified.tid ?? '').toLowerCase();
      if (!allowedTenants().some((t) => t.id === tid)) throw new Error('Bu kiracı için erişim yok');
      const { payload } = await jwtVerify(body.id_token, jwks, { issuer: `https://login.microsoftonline.com/${tid}/v2.0`, audience: config.ENTRA_CLIENT_ID });
      if (payload.nonce !== saved.nonce) throw new Error('Nonce uyuşmuyor');
      const user = await resolveEmployee(db, {
        tid, oid: String(payload.oid), name: String(payload.name ?? ''),
        email: String(payload.preferred_username ?? payload.email ?? ''),
        roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
      });
      startSession(res, user);
      res.redirect('/');
    } catch (e) {
      res.status(403).send(`Giriş başarısız: ${(e as Error).message}`);
    }
  });

  // Local development only: AUTH_MODE=dev is refused at startup in production.
  r.post('/auth/dev', async (req, res) => {
    if (config.AUTH_MODE !== 'dev') return void res.status(404).end();
    const { email, name, role, tenant } = req.body ?? {};
    const t = allowedTenants()[0]?.id ?? 'dev-tenant';
    const user = await resolveEmployee(db, { tid: tenant ?? t, oid: `dev-${email}`, email: String(email), name: String(name ?? email), roles: role ? [role] : [] });
    startSession(res, user);
    res.json(user);
  });

  r.post('/auth/logout', (_req, res) => { endSession(res); res.json({ ok: true }); });
  r.get('/api/me', (req, res) => (req.user ? res.json(req.user) : res.status(401).json({ error: 'Oturum gerekli' })));
  return r;
}
