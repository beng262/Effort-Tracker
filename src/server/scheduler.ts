import { addDays, isoWeekday, mondayOf } from '../core/turkish.js';
import { config } from './config.js';
import type { Db } from './db.js';
import { reportToXlsx } from './export.js';
import { syncAll, type Graph } from './graph.js';
import { loadItsm, runItsmSync, type ItsmSetup } from './itsm.js';
import type { Vault } from './secrets.js';
import type { Mailer } from './mail.js';
import { definitionSchema, runReport } from './reports.js';
import type { User } from './session.js';

/** Wall-clock parts in Istanbul, so "Friday 15:00" means what people expect on a server running UTC. */
export function istanbulNow(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, hour: Number(parts.hour), weekday: isoWeekday(date) + 1 /* 1 = Monday */ };
}

const prevMonth = (date: string) => {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const mm = String(pm).padStart(2, '0');
  return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(lastDay).padStart(2, '0')}` };
};

interface SavedReport {
  id: string; owner_id: string; name: string; definition: unknown; last_run_date: string | null;
  schedule: { kind: 'monthly' | 'weekly'; day: number; hour: number; recipients: string[] };
}

/** Reports whose schedule says they are due now and have not run today. */
export async function runDueReports(db: Db, mail: Mailer, now = istanbulNow()): Promise<number> {
  const due = (await db.query<SavedReport>(`SELECT id, owner_id, name, definition, schedule, last_run_date FROM report_definitions WHERE schedule IS NOT NULL`)).rows;
  let sent = 0;
  for (const rep of due) {
    const s = rep.schedule;
    const dayMatches = s.kind === 'monthly' ? now.date.slice(8) === String(s.day).padStart(2, '0') : now.weekday === s.day;
    if (!dayMatches || now.hour < s.hour) continue;
    if (rep.last_run_date === now.date) continue;
    const owner = (await db.query<{ id: string; name: string; email: string; role: User['role']; day_hours: number }>(
      `SELECT id, name, email, role, day_hours FROM employees WHERE id=$1 AND active`, [rep.owner_id])).rows[0];
    if (!owner) continue;
    const user: User = { employeeId: owner.id, name: owner.name, email: owner.email, role: owner.role, dayHours: owner.day_hours };
    const def = definitionSchema.parse(rep.definition);
    // Monthly: the previous month. Weekly: the last seven days.
    if (s.kind === 'monthly') Object.assign(def, prevMonth(now.date));
    else Object.assign(def, { from: addDays(now.date, -6), to: now.date });
    const result = await runReport(db, user, def, now.date, rep.name);
    await mail.send(
      s.recipients,
      `Efor raporu: ${rep.name} (${def.from} – ${def.to})`,
      `${rep.name}\nDönem: ${def.from} – ${def.to}\nToplam: ${result.total}\n\nAyrıntı ekteki Excel dosyasındadır.`,
      [{ filename: `efor-${def.from}_${def.to}.xlsx`, content: await reportToXlsx(result) }],
    );
    await db.query('UPDATE report_definitions SET last_run_at=now(), last_run_date=$2 WHERE id=$1', [rep.id, now.date]);
    sent++;
  }
  return sent;
}

/** Friday afternoon: people with a weekday this week and no confirmed effort get a nudge. */
export async function runReminders(db: Db, mail: Mailer, now = istanbulNow()): Promise<number> {
  if (now.weekday !== 5 || now.hour < 15) return 0;
  const done = (await db.query<{ last_detail: string | null }>(`SELECT last_detail FROM job_runs WHERE name='reminders'`)).rows[0];
  if (done?.last_detail === now.date) return 0;
  const start = mondayOf(now.date);
  const days = [0, 1, 2, 3, 4].map((i) => addDays(start, i));
  const people = (await db.query<{ id: string; email: string; name: string }>(`SELECT id, email, name FROM employees WHERE active`)).rows;
  const have = (await db.query<{ employee_id: string; d: string }>(
    `SELECT DISTINCT employee_id, work_date AS d FROM entries WHERE NOT deleted AND status <> 'draft' AND work_date BETWEEN $1 AND $2`, [start, days[4]])).rows;
  const set = new Set(have.map((h) => `${h.employee_id}|${h.d}`));
  let n = 0;
  for (const p of people) {
    const missing = days.filter((d) => !set.has(`${p.id}|${d}`));
    if (!missing.length) continue;
    await mail.send([p.email], 'Efor hatırlatma: eksik günler',
      `Merhaba ${p.name.split(' ')[0]},\nBu hafta şu günler için efor girişi görünmüyor: ${missing.map((d) => `${d.slice(8)}.${d.slice(5, 7)}`).join(', ')}.\nİzinli olduğunuz günleri girmeniz gerekmez.`);
    n++;
  }
  await db.query(`INSERT INTO job_runs (name,last_run_at,last_status,last_detail) VALUES ('reminders',now(),'ok',$1) ON CONFLICT (name) DO UPDATE SET last_run_at=now(), last_status='ok', last_detail=$1`, [now.date]);
  return n;
}

export function startJobs(db: Db, graph: Graph, mail: Mailer, itsmSetup: ItsmSetup, vault: Vault) {
  const tick = async () => {
    // withLock makes each job run on one instance even when several are up.
    await db.withLock('efor-jobs', async () => {
      try {
        if (config.SYNC_ENABLED) {
          const last = (await db.query<{ age: number | null }>(`SELECT extract(epoch from now() - last_run_at) AS age FROM job_runs WHERE name='planner-sync'`)).rows[0];
          if (!last || last.age === null || last.age >= config.SYNC_INTERVAL_MIN * 60) await syncAll(db, graph);
        }
        const itsm = await loadItsm(itsmSetup, vault);
        if (itsm && itsmSetup.tenantId && config.SYNC_ENABLED) {
          const last = (await db.query<{ age: number | null }>(`SELECT extract(epoch from now() - last_run_at) AS age FROM job_runs WHERE name='itsm-sync'`)).rows[0];
          if (!last || last.age === null || last.age >= config.SYNC_INTERVAL_MIN * 60) await runItsmSync(db, itsm, itsmSetup.tenantId);
        }
        if (config.SCHEDULER_ENABLED) {
          await runDueReports(db, mail);
          await runReminders(db, mail);
        }
      } catch (e) {
        console.error('job tick failed', e);
      }
    });
  };
  const h = setInterval(() => void tick(), 60_000);
  h.unref();
  void tick();
  return () => clearInterval(h);
}
