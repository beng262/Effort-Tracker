// Local demo server: in-memory Postgres (PGlite), sample data, and a rule-based stand-in for the model.
// Not part of the production build. Run with: npm run dev:local
import './env.js'; // must come first: config reads the environment when it is imported
import { PGlite } from '@electric-sql/pglite';
import type { Ai } from '../server/ai.js';
import { buildApp } from '../server/app.js';
import type { Ctx } from '../server/context.js';
import type { Db } from '../server/db.js';
import { migrate } from '../server/migrate.js';
import { istanbulNow } from '../server/scheduler.js';
import type { Extraction, ProposedRow } from '../core/types.js';
import { memoryVault } from '../server/secrets.js';
import { createEntry, confirmEntries } from '../server/entries.js';
import { addProjectFile } from '../server/projectFiles.js';
import { addDays, mondayOf } from '../core/turkish.js';
import type { CalendarApi, GraphEvent } from '../server/calendar.js';
import { addDays } from '../core/turkish.js';

const pg = new PGlite({ parsers: { 1700: (v: string) => parseFloat(v), 1082: (v: string) => v } });
const wrap = (c: any, inTx = false): Db => ({
  query: async (sql, params) => ({ rows: (await c.query(sql, params)).rows }),
  exec: async (sql) => { await c.exec(sql); },
  tx: async (fn) => (inTx ? fn(wrap(c, true)) : pg.transaction((t) => fn(wrap(t, true)))),
  withLock: async (_n, fn) => fn(),
});
const db = wrap(pg);
await migrate(db);

// A stand-in for the model: reads "pzt - müşteri toplantısı 3s" style lines. The real model replaces it in production.
const LINE = /^\s*\+?\s*(pzt|pazartesi|sal[ıi]|çrş|çar|çarşamba|per\.?|perşembe|cuma|cmt|paz|bugün|dün|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)\s*[-–:]?\s*(.*)$/i;
const EFFORT = /(\d+(?:[.,]\d+)?\s*(?:saat|sa|s|dk)\b|yarım gün|\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2})/i;
const demoAi: Ai = {
  model: 'demo-rule-based',
  async extract(input) {
    const rows: ProposedRow[] = [];
    let lastDay: string | null = null;
    input.compact.split('\n').forEach((raw) => {
      const lineNo = raw.match(/^L(\d+):\s?(.*)$/);
      const text = lineNo ? lineNo[2] : raw;
      const m = text.match(LINE);
      const day = m?.[1] ?? (text.trim().startsWith('+') ? lastDay : null);
      if (!day) return;
      lastDay = day;
      const rest = m ? m[2] : text.replace(/^\s*\+\s*/, '');
      const e = rest.match(EFFORT);
      const leave = !e && /\bizin\b/i.test(rest);
      const ticket = rest.match(/\b[A-Z]{2,5}-\d{3,}\b/)?.[0] ?? null;
      rows.push({
        date: day, time: e && /[:.]\d{2}\s*[-–]/.test(e[1]) ? e[1] : null, effort: e && !/[:.]\d{2}\s*[-–]/.test(e[1]) ? e[1] : null,
        description: rest.replace(EFFORT, '').replace(ticket ?? '', '').replace(/\s+/g, ' ').trim(), task_hint: null, ticket_hint: ticket, project_hint: null,
        leave, confidence: e || leave ? 0.9 : 0.4, source: lineNo ? `L${lineNo[1]}` : 'L1', source_text: text.trim(),
      });
    });
    return { rows, mappings: [], notes: ['Demo kipi: kural tabanlı okuyucu kullanıldı, gerçek model değil.'] } satisfies Extraction;
  },
  async pick() { return {}; },
  async extractPlan() { return { tasks: [], notes: ['Demo kipinde yapay zekâ ile plan okuma kapalı.'] }; },
  // Rule-based stand-in: "W1.4 tamamlandı", "W2.1 30 Ekim". The real model replaces it in production; code validates either way.
  async editPlan({ instruction, tasks }) {
    const edits: { ext_id: string; field: 'status' | 'due_date'; value: string }[] = [];
    for (const t of tasks) {
      const m = instruction.match(new RegExp(`${t.ext_id.replace('.', '\.')}[^,;.]*`, 'i'));
      if (!m) continue;
      const st = m[0].match(/tamamland[ıi]|bitti|devam|bloke/i);
      const dt = m[0].match(/\d{1,2}\s+(?:ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)/i);
      if (st) edits.push({ ext_id: t.ext_id, field: 'status', value: st[0] });
      if (dt) edits.push({ ext_id: t.ext_id, field: 'due_date', value: dt[0] });
    }
    return { edits, added: [], notes: ['Demo kipi: kural tabanlı asistan kullanıldı.'] };
  },
  async chat(messages) {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const toolDone = messages[messages.length - 1].role === 'tool';
    if (toolDone) return { content: 'Hazır. Ayrıntılar aşağıdaki kartta.', toolCalls: [] };
    if (/ne kadar|toplam|kaç saat/i.test(last)) {
      const t = istanbulNow().date;
      return { content: null, toolCalls: [{ id: 'd1', name: 'my_effort', args: JSON.stringify({ from: `${t.slice(0, 8)}01`, to: t, group_by: ['project'], link_kind: null }) }] };
    }
    if (/biçim|markdown|tablo/i.test(last)) return { content: `Haftanız **eksiksiz** görünüyor; *ekstra mesai* yok.

## Günlere göre

| Gün | Proje | Not |
| --- | --- | --- |
| Pazartesi | Alder | \`deploy\` |
| Salı | Birch | toplantı |

- **Eksik gün:** yok
- Rapor: [Raporlar](https://effort.example.com)

<script>alert(1)</script>`, toolCalls: [] };
    if (EFFORT.test(last)) return { content: null, toolCalls: [{ id: 'd2', name: 'add_entries', args: JSON.stringify({ text: last }) }] };
    return { content: 'Demo kipindeyim: "bugün 3 saat X" yazabilir ya da "bu ay ne kadar çalıştım?" diye sorabilirsiniz.', toolCalls: [] };
  },
};

// Sample data: one tenant, a PM, two employees, a project with Planner tasks.
await db.query(`INSERT INTO tenants (id,name,domain) VALUES ('dev-tenant','Dev','example.com')`);
const mk = async (name: string, email: string, role: string) => {
  const id = (await db.query(`INSERT INTO employees (name,email,role) VALUES ($1,$2,$3) RETURNING id`, [name, email, role])).rows[0].id;
  await db.query(`INSERT INTO identities (employee_id,tenant_id,email,entra_oid) VALUES ($1,'dev-tenant',$2,$3)`, [id, email, `dev-${email}`]);
  return id;
};
const cansu = await mk('Cansu (PM)', 'cansu@example.com', 'PM');
const ayse = await mk('Ayşe', 'ayse@example.com', 'Employee');
const mehmet = await mk('Mehmet', 'mehmet@example.com', 'Employee');
await mk('Admin', 'admin@example.com', 'Admin');
const proj = (await db.query(`INSERT INTO projects (name, customer, tenant_id, created_by) VALUES ('Lisans Yönetimi','Acme','dev-tenant',$1) RETURNING id`, [cansu])).rows[0].id;
await db.query(`INSERT INTO project_plans (project_id,tenant_id,plan_id,plan_title) VALUES ($1,'dev-tenant','plan1','Lisans planı')`, [proj]);
for (const e of [ayse, mehmet]) await db.query(`INSERT INTO employee_projects VALUES ($1,$2)`, [e, proj]);
await db.query(`INSERT INTO planner_tasks (tenant_id,id,plan_id,bucket,title,assignee_oids) VALUES
  ('dev-tenant','t1','plan1','Raporlama','Lisans raporu','{dev-ayse@example.com}'),
  ('dev-tenant','t2','plan1','UAT','UAT testleri','{dev-ayse@example.com}'),
  ('dev-tenant','t3','plan1','Ağ','Faz 2 – Ağ','{dev-mehmet@example.com}')`);

// A pretend calendar: "connecting" is instant, and the week has a handful of meetings (some that are skipped on purpose).
const demoCalendar: CalendarApi = {
  authorizeUrl: ({ redirectUri, state }) => `${redirectUri}?code=demo&state=${state}`,
  exchangeCode: async () => ({ refreshToken: 'demo-refresh', accessToken: 'demo', tid: null, oid: null }),
  refresh: async () => ({ accessToken: 'demo', refreshToken: 'demo-refresh' }),
  events: async (_token, from) => {
    const monday = from.slice(0, 10);
    const ev = (id: string, day: number, start: string, end: string, subject: string, extra: Partial<GraphEvent> = {}): GraphEvent =>
      ({ id, subject, isAllDay: false, isCancelled: false, showAs: 'busy', start: { dateTime: `${addDays(monday, day)}T${start}:00.0000000` }, end: { dateTime: `${addDays(monday, day)}T${end}:00.0000000` }, ...extra });
    return [
      ev('m1', 0, '10:00', '11:00', 'Lisans Yönetimi haftalık toplantı', { isOnlineMeeting: true, organizer: { emailAddress: { name: 'Cansu' } }, attendees: [{}, {}, {}] }),
      ev('m2', 1, '14:00', '15:30', 'Müşteri toplantısı: kapsam netleştirme', { isOnlineMeeting: true, organizer: { emailAddress: { name: 'Mehmet' } }, attendees: [{}, {}] }),
      ev('m3', 2, '09:30', '10:00', 'Günlük stand-up', { isOnlineMeeting: true, attendees: [{}, {}, {}, {}] }),
      ev('m4', 2, '13:00', '14:00', 'Mimari gözden geçirme'),
      ev('m5', 3, '11:00', '12:00', 'Eğitim: Entra ID temelleri', { isOnlineMeeting: true }),
      ev('x1', 1, '09:00', '10:00', 'İptal edilen toplantı', { isCancelled: true }),
      ev('x2', 3, '00:00', '23:59', 'Resmi izin', { isAllDay: true }),
    ];
  },
};

const store = new Map<string, Buffer>();
const ctx: Ctx = { db, ai: demoAi, vault: memoryVault(), itsm: { baseUrl: null, tenantId: null, make: () => null }, calendar: demoCalendar, blob: { put: async (p, d) => { store.set(p, d); }, get: async (p) => store.get(p) ?? Buffer.alloc(0), remove: async (p) => { store.delete(p); } }, today: () => istanbulNow().date };
// Sample effort for this week (Monday until today), and a few tickets, so the demo opens with something to look at.
{
  const today = ctx.today();
  const monday = mondayOf(today);
  type Sample = [number, number, string, string, string, string | null, string | null];
  const week: Record<string, Sample[]> = {
    ayse: [
      [0, 5, 'Lisans raporu hazırlandı, taslak paylaşıldı', 'Proje', 'Acme', 'Lisans Yönetimi', 'Microsoft 365'],
      [0, 3, 'Ekip toplantısı ve haftalık planlama', 'İç Operasyon', 'İç Çalışma', null, null],
      [1, 4, 'UAT test senaryoları yazıldı', 'Proje', 'Acme', 'Lisans Yönetimi', 'Microsoft 365'],
      [1, 2, 'Müşteri toplantısı: kapsam netleştirme', 'Proje', 'Acme', 'Lisans Yönetimi', null],
      [1, 2, 'Destek talepleri yanıtlandı', 'SLA', 'Acme', 'Aylık destek (SLA)', 'Exchange Online'],
      [2, 6, 'Faz 2 ağ keşfi ve envanter çıkarıldı', 'Proje', 'Acme', 'Lisans Yönetimi', 'Ağ'],
      [2, 2, 'Entra ID erişim incelemesi, teknik araştırma', 'Teknik Çözüm / Ar-Ge', 'İç Çalışma', null, 'Microsoft Entra ID'],
      [3, 8, 'Lisans optimizasyon raporu', 'Proje', 'Acme', 'Lisans Yönetimi', 'Microsoft 365'],
      [4, 7, 'Faz 2 geçiş planı', 'Proje', 'Acme', 'Lisans Yönetimi', 'Ağ'],
    ],
    mehmet: [
      [0, 8, 'Güvenlik duvarı kural düzenlemesi', 'Proje', 'Acme', 'Lisans Yönetimi', 'Ağ'],
      [1, 8, 'Faz 2 ağ topolojisi çalışması', 'Proje', 'Acme', 'Lisans Yönetimi', 'Ağ'],
    ],
  };
  for (const [who, rows] of Object.entries(week)) {
    const id = who === 'ayse' ? ayse : mehmet;
    for (const [d, hours, description, category, customer, workItem, product] of rows) {
      const date = addDays(monday, d);
      if (date > today) continue;
      const e = await createEntry(ctx, id, 8, { date, hours, description, category, customer, workItem, product, projectId: category === 'Proje' ? proj : null });
      await confirmEntries(db, id, [e.id]);
    }
  }
  await db.query(`INSERT INTO itsm_tickets (id, tenant_id, title, customer, assignee, status, opened_at) VALUES
    ('4101','dev-tenant','VPN bağlantısı kopuyor','Acme','ayse@example.com','Açık', now() - interval '3 days'),
    ('4102','dev-tenant','Paylaşımlı posta kutusu izinleri','Acme','ayse@example.com','Devam Ediyor', now() - interval '6 days'),
    ('4103','dev-tenant','Yeni kullanıcı hesabı talebi','Acme','mehmet@example.com','Açık', now() - interval '1 day')`);
}
// Sample files on the demo project (the bytes are short pretend documents).
{
  const pm = { employeeId: cansu, name: 'Cansu (PM)', email: 'cansu@example.com', role: 'PM', dayHours: 8 } as const;
  const member = { employeeId: ayse, name: 'Ayşe', email: 'ayse@example.com', role: 'Employee', dayHours: 8 } as const;
  await addProjectFile(ctx, pm, proj, 'Kapsam Dokümanı v2.pdf', Buffer.from('Kapsam dokümanı (demo içeriği)'), 'müşteriyle onaylanan sürüm');
  await addProjectFile(ctx, member, proj, 'Teklif.xlsx', Buffer.from('Teklif tablosu (demo içeriği)'), 'birim fiyatlar dahil');
  await addProjectFile(ctx, member, proj, 'Toplantı notları 19.10.md', Buffer.from('Toplantı notları: kapsam netleşti'));
  await addProjectFile(ctx, pm, proj, 'Mimari şema.png', Buffer.from('şema (demo içeriği)'), 'yüksek seviye mimari');
}
const port = Number(process.env.PORT ?? 3100);
buildApp(ctx, { get: async () => { throw new Error('Demo kipinde Microsoft Graph bağlı değil'); } }).listen(port, () => console.log(`Efor demo on http://localhost:${port} (dev login: cansu@example.com PM, ayse@example.com, admin@example.com Admin)`));
