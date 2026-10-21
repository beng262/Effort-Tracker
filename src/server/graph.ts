import { config } from './config.js';
import type { Db } from './db.js';

/** Minimal Graph surface, so the sync can be tested with a fake. */
export interface Graph {
  get(tenantId: string, pathOrUrl: string): Promise<any>;
}

const tokens = new Map<string, { token: string; exp: number }>();

/** App-only Graph access. The same multi-tenant app is consented once per tenant by an admin. */
export function createGraph(): Graph {
  async function token(tenantId: string): Promise<string> {
    const hit = tokens.get(tenantId);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    if (!config.ENTRA_CLIENT_ID || !config.ENTRA_CLIENT_SECRET) throw new Error('ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET not set');
    const r = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.ENTRA_CLIENT_ID, client_secret: config.ENTRA_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
    });
    const b: any = await r.json();
    if (!r.ok) throw new Error(`Graph token (${tenantId}): ${b.error_description ?? r.status}`);
    tokens.set(tenantId, { token: b.access_token, exp: Date.now() + b.expires_in * 1000 });
    return b.access_token;
  }
  return {
    async get(tenantId, pathOrUrl) {
      const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await fetch(url, { headers: { authorization: `Bearer ${await token(tenantId)}` } });
        if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
        if (!r.ok) throw new Error(`Graph ${r.status} ${url}: ${(await r.text()).slice(0, 200)}`);
        return r.json();
      }
      throw new Error(`Graph gave up: ${url}`);
    },
  };
}

async function allPages(g: Graph, tenantId: string, path: string): Promise<any[]> {
  const out: any[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: any = await g.get(tenantId, next);
    out.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return out;
}

export interface PlanInfo { id: string; title: string; groupId: string; groupName: string }

export interface Discovery {
  plans: PlanInfo[];
  /** Microsoft 365 groups looked at. */
  groups: number;
  /** Groups whose plans could not be read, with the reason, so a missing plan is never a silent gap. */
  skipped: { group: string; reason: string }[];
}

/** Plans Cansu can import: every Microsoft 365 group's Planner plans in a tenant. */
export async function discoverPlans(g: Graph, tenantId: string): Promise<Discovery> {
  const groups = await allPages(g, tenantId, `/groups?$filter=groupTypes/any(c:c eq 'Unified')&$select=id,displayName&$top=100`);
  const plans: PlanInfo[] = [];
  const skipped: Discovery['skipped'] = [];
  for (const grp of groups) {
    try {
      for (const p of await allPages(g, tenantId, `/groups/${grp.id}/planner/plans`)) {
        plans.push({ id: p.id, title: p.title, groupId: grp.id, groupName: grp.displayName });
      }
    } catch (e) {
      skipped.push({ group: grp.displayName, reason: (e as Error).message.replace(/https:\/\/graph\.microsoft\.com\/v1\.0/g, '').slice(0, 160) });
    }
  }
  return { plans, groups: groups.length, skipped };
}

export interface SyncResult { tenantId: string; plans: number; tasks: number; removed: number; error?: string }

/**
 * Refresh the cached tasks of every plan linked to a project. Planner offers no change feed for tasks,
 * so each linked plan is re-read in full and tasks that disappeared are removed from the cache.
 */
export async function syncTenant(db: Db, g: Graph, tenantId: string): Promise<SyncResult> {
  const plans = (await db.query<{ plan_id: string }>(`SELECT pp.plan_id FROM project_plans pp JOIN projects p ON p.id = pp.project_id WHERE pp.tenant_id=$1 AND p.active`, [tenantId])).rows;
  const res: SyncResult = { tenantId, plans: 0, tasks: 0, removed: 0 };
  for (const { plan_id } of plans) {
    try {
      const [plan, buckets, tasks] = await Promise.all([
        g.get(tenantId, `/planner/plans/${plan_id}`),
        allPages(g, tenantId, `/planner/plans/${plan_id}/buckets`),
        allPages(g, tenantId, `/planner/plans/${plan_id}/tasks`),
      ]);
      const bucketName = new Map<string, string>(buckets.map((b: any) => [b.id, b.name]));
      await db.tx(async (t) => {
        await t.query(`UPDATE project_plans SET plan_title=$3 WHERE tenant_id=$1 AND plan_id=$2`, [tenantId, plan_id, plan.title]);
        for (const task of tasks) {
          await t.query(
            `INSERT INTO planner_tasks (tenant_id, id, plan_id, bucket, title, assignee_oids, start_date, due_date, percent_complete, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
             ON CONFLICT (tenant_id, id) DO UPDATE SET plan_id=EXCLUDED.plan_id, bucket=EXCLUDED.bucket, title=EXCLUDED.title,
               assignee_oids=EXCLUDED.assignee_oids, start_date=EXCLUDED.start_date, due_date=EXCLUDED.due_date,
               percent_complete=EXCLUDED.percent_complete, synced_at=now()`,
            [tenantId, task.id, plan_id, bucketName.get(task.bucketId) ?? null, task.title, Object.keys(task.assignments ?? {}),
              task.startDateTime?.slice(0, 10) ?? null, task.dueDateTime?.slice(0, 10) ?? null, task.percentComplete ?? 0]);
        }
        const keep = tasks.map((x: any) => x.id);
        const del = await t.query(`DELETE FROM planner_tasks WHERE tenant_id=$1 AND plan_id=$2 AND NOT (id = ANY($3::text[])) RETURNING id`, [tenantId, plan_id, keep]);
        res.removed += del.rows.length;
      });
      res.plans++;
      res.tasks += tasks.length;
    } catch (e) {
      res.error = (res.error ? res.error + '; ' : '') + `${plan_id}: ${(e as Error).message}`;
    }
  }
  await db.query(`UPDATE tenants SET graph_state=$2, graph_checked_at=now() WHERE id=$1`, [tenantId, res.error && !res.plans ? 'error' : 'consented']);
  return res;
}

export async function syncAll(db: Db, g: Graph): Promise<SyncResult[]> {
  const tenants = (await db.query<{ id: string }>(`SELECT DISTINCT pp.tenant_id AS id FROM project_plans pp JOIN projects p ON p.id = pp.project_id WHERE p.active`)).rows;
  const out: SyncResult[] = [];
  for (const t of tenants) out.push(await syncTenant(db, g, t.id));
  await db.query(`INSERT INTO job_runs (name,last_run_at,last_status,last_detail) VALUES ('planner-sync',now(),$1,$2)
                  ON CONFLICT (name) DO UPDATE SET last_run_at=now(), last_status=$1, last_detail=$2`,
    [out.some((r) => r.error) ? 'partial' : 'ok', JSON.stringify(out)]);
  return out;
}
