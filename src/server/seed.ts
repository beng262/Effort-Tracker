import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedTenants } from './config.js';
import type { Db } from './db.js';

interface SeedPerson { name: string; email: string; tenant: string; role: 'Employee' | 'PM' | 'Admin'; alt?: { tenant: string; email: string }[] }

/**
 * Create the known people and their tenant identities, so the first sign-in matches by e-mail.
 * Idempotent: an existing person keeps whatever role and name they have now.
 * `tenant` is matched against the allowed tenants by name or domain, case-insensitively.
 */
export async function seedPeople(db: Db, file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'seed', 'people.json')): Promise<number> {
  if (!existsSync(file)) return 0;
  const { people } = JSON.parse(readFileSync(file, 'utf8')) as { people: SeedPerson[] };
  const tenants = allowedTenants();
  let n = 0;
  for (const p of people) {
    const find = (name: string) => tenants.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.domain.toLowerCase().startsWith(name.toLowerCase()));
    const t = find(p.tenant);
    if (!t) { console.warn(`seed: no allowed tenant for "${p.tenant}" (${p.email}), skipped`); continue; }
    await db.tx(async (tx) => {
      await tx.query(`INSERT INTO tenants (id, name, domain) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [t.id, t.name, t.domain]);
      const email = p.email.toLowerCase();
      const id = (await tx.query<{ id: string }>(
        `INSERT INTO employees (name, email, role) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`, [p.name, email, p.role])).rows[0].id;
      await tx.query(`INSERT INTO identities (employee_id, tenant_id, email) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, email) DO NOTHING`, [id, t.id, email]);
      // A second account in the other tenant belongs to the same employee, so effort never splits in two.
      for (const a of p.alt ?? []) {
        const at = find(a.tenant);
        if (!at) continue;
        await tx.query(`INSERT INTO tenants (id, name, domain) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [at.id, at.name, at.domain]);
        await tx.query(`INSERT INTO identities (employee_id, tenant_id, email) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, email) DO NOTHING`, [id, at.id, a.email.toLowerCase()]);
      }
    });
    n++;
  }
  return n;
}
