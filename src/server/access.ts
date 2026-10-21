import type { Db } from './db.js';
import { atLeast, type User } from './session.js';

/**
 * The one place that decides whose effort a person may see.
 * Employee: own rows. PM: own rows plus rows on projects they created. Admin: everything.
 * The app and the chat tools both build their queries from this, so they can never disagree.
 */
export function entryScope(user: User, alias = 'e', startIdx = 1): { sql: string; params: unknown[] } {
  if (user.role === 'Admin') return { sql: 'TRUE', params: [] };
  if (user.role === 'PM') {
    return {
      // Own effort, effort booked on the PM's projects, and everything (all projects, or none) that the people on those projects logged.
      sql: `(${alias}.employee_id = $${startIdx}
        OR ${alias}.project_id IN (SELECT id FROM projects WHERE created_by = $${startIdx})
        OR ${alias}.employee_id IN (SELECT ep.employee_id FROM employee_projects ep JOIN projects p ON p.id = ep.project_id WHERE p.created_by = $${startIdx} AND p.active))`,
      params: [user.employeeId],
    };
  }
  return { sql: `${alias}.employee_id = $${startIdx}`, params: [user.employeeId] };
}

export async function canSeeEmployee(db: Db, user: User, employeeId: string): Promise<boolean> {
  if (user.employeeId === employeeId || user.role === 'Admin') return true;
  if (!atLeast(user, 'PM')) return false;
  const r = await db.query(
    `SELECT 1 FROM employee_projects ep JOIN projects p ON p.id = ep.project_id
      WHERE ep.employee_id = $1 AND p.created_by = $2 LIMIT 1`, [employeeId, user.employeeId]);
  return r.rows.length > 0;
}

export async function audit(db: Db, actor: string | null, action: string, target?: string, detail?: unknown) {
  await db.query('INSERT INTO audit_events (actor_id, action, target, detail) VALUES ($1,$2,$3,$4)', [actor, action, target ?? null, detail === undefined ? null : JSON.stringify(detail)]);
}
