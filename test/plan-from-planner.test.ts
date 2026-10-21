import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './testdb.js';
import type { Db } from '../src/server/db.js';
import { stagePlannerImport } from '../src/server/plans.js';
import { candidatesFor } from '../src/server/pipeline.js';

describe('project plan from Planner, and finished tickets', () => {
  let db: Db; let pm: any; let proj: string; let emp: string;
  const ctx = () => ({ db, today: () => '2026-10-15', ai: { model: 'unconfigured' } } as any);

  beforeAll(async () => {
    db = await testDb();
    await db.query(`INSERT INTO tenants (id,name,domain) VALUES ('t1','T','x.com')`);
    emp = (await db.query(`INSERT INTO employees (name,email,role) VALUES ('Murat Aydın','m@x.com','PM') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO identities (employee_id, tenant_id, email, entra_oid) VALUES ($1,'t1','m@x.com','oid-1')`, [emp]);
    proj = (await db.query(`INSERT INTO projects (name, created_by) VALUES ('Birch',$1) RETURNING id`, [emp])).rows[0].id;
    await db.query(`INSERT INTO employee_projects VALUES ($1,$2)`, [emp, proj]);
    pm = { employeeId: emp, role: 'PM' };
  });

  it('says so when no Planner plan is linked', async () => {
    const r = await stagePlannerImport(ctx(), pm, proj);
    expect(r.actionId).toBeNull();
    expect(r.notes[0]).toContain('bağlı değil');
  });

  it('turns Planner tasks into plan rows with bucket, owner, date and status from percent', async () => {
    await db.query(`INSERT INTO project_plans (project_id, tenant_id, plan_id, plan_title) VALUES ($1,'t1','p1','Plan')`, [proj]);
    const task = (id: string, title: string, pct: number) => db.query(
      `INSERT INTO planner_tasks (tenant_id,id,plan_id,bucket,title,assignee_oids,due_date,percent_complete) VALUES ('t1',$1,'p1','Faz 1',$2,ARRAY['oid-1'],'2026-11-01',$3)`, [id, title, pct]);
    await task('aaaaaaaa11', 'Kurulum', 0); await task('bbbbbbbb22', 'Test', 50); await task('cccccccc33', 'Teslim', 100);
    const r = await stagePlannerImport(ctx(), pm, proj);
    expect(r.tasks.find((t) => t.title === 'Test')).toMatchObject({ extId: 'PL-bbbbbbbb', section: 'Faz 1', owner: 'Murat Aydın', dueDate: '2026-11-01', status: 'Devam' });
    expect(r.tasks.find((t) => t.title === 'Kurulum')!.status).toBe('Planlandı');
    expect(r.tasks.find((t) => t.title === 'Teslim')!.status).toBe('Tamamlandı');
    expect(r.actionId).toBeTruthy();
  });

  it('marks closed tickets so the task list can leave them out', async () => {
    await db.query(`INSERT INTO itsm_tickets (tenant_id,id,title,assignee,status,opened_at,closed_at) VALUES ('t1','1','Açık iş','m@x.com','Açık',now(),NULL),('t1','2','Bitmiş iş','m@x.com','Closed',now(),now())`);
    const c = (await candidatesFor(db, emp, null)).filter((x) => x.kind === 'itsm');
    expect(c.find((x) => x.id === '1')!.status).toBe('Açık');
    expect(c.find((x) => x.id === '2')!.status).toBe('Kapalı'); // still linkable by "#2", not offered as a to-do
  });
});
