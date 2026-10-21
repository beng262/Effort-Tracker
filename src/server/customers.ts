import { fold } from '../core/turkish.js';
import { audit } from './access.js';
import type { Db } from './db.js';
import { EntryError } from './entries.js';

export interface Customer { name: string; source: 'itsm' | 'manual' | 'project' }

/** Customers seen in ITSM tickets first, then ones added by hand or typed on projects. One entry per name (case and accents ignored). */
export async function listCustomers(db: Db): Promise<Customer[]> {
  const rows = (await db.query<Customer>(
    `SELECT name, source FROM (
       SELECT DISTINCT btrim(customer) AS name, 'itsm' AS source FROM itsm_tickets WHERE btrim(coalesce(customer,'')) <> ''
       UNION ALL SELECT name, 'manual' FROM customers
       UNION ALL SELECT DISTINCT btrim(customer), 'project' FROM projects WHERE active AND btrim(coalesce(customer,'')) <> ''
     ) x`)).rows;
  const order = { itsm: 0, manual: 1, project: 2 };
  const seen = new Map<string, Customer>();
  for (const r of rows.sort((a, b) => order[a.source] - order[b.source])) { const k = fold(r.name); if (!seen.has(k)) seen.set(k, r); }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

/** Add a customer unless one with the same name exists; returns the stored spelling. */
export async function addCustomer(db: Db, employeeId: string, raw: string): Promise<Customer> {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new EntryError('Müşteri adı en az 2 karakter olmalı');
  if (name.length > 200) throw new EntryError('Müşteri adı çok uzun');
  const have = (await listCustomers(db)).find((c) => fold(c.name) === fold(name));
  if (have) return have;
  await db.query('INSERT INTO customers (name, created_by) VALUES ($1,$2) ON CONFLICT DO NOTHING', [name, employeeId]);
  await audit(db, employeeId, 'customer_add', name);
  return { name, source: 'manual' };
}
