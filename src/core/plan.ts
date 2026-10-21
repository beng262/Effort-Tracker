import { fold, parseDate } from './turkish.js';
import type { PreRead } from './grid.js';

export const STATUSES = ['Planlandı', 'Devam', 'Tamamlandı', 'Bloke'] as const;
export type PlanStatus = (typeof STATUSES)[number];

export interface PlanTask {
  extId: string;
  section: string | null;
  title: string;
  owner: string | null;
  dependsOn: string | null;
  dueDate: string | null; // ISO
  status: PlanStatus;
}

export function normalizeStatus(raw: string | null | undefined): PlanStatus | null {
  if (!raw) return null;
  const s = fold(raw);
  if (/^(planlandi|planlanan|planned|beklemede|baslamadi|todo|to do)$/.test(s)) return 'Planlandı';
  if (/^(devam|devam ediyor|devam eden|surecte|in progress|aktif)$/.test(s)) return 'Devam';
  if (/^(tamamlandi|tamam|bitti|bitmis|kapandi|done|complete|completed)$/.test(s)) return 'Tamamlandı';
  if (/^(bloke|blokeli|blocked|engelli)$/.test(s)) return 'Bloke';
  return null;
}

// "W1.4", "F0", "T-01", "KT-1" and plain numbered ids such as "0.1" or "2.10"
const ID_RE = /^(?:[A-Za-z]{1,4}-?\d+(?:[.\-]\d+)*|\d+(?:\.\d+)+)$/;
const PLAN_SHEET = /plan|backlog|gorev|task|is paketi|kilometre|teslimat/;

export interface PlanParse { tasks: PlanTask[]; notes: string[] }

interface Cols { id: number; title: number; owner: number; dep: number; due: number; status: number; type: number }

/** Find a header row such as "ID | Faz / Görev | … | Sorumlu | … | Bitiş | … | Durum | Tip" and map its columns. */
function findHeader(rows: string[][]): { row: number; cols: Cols } | null {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const f = rows[r].map((c) => fold(c));
    const idx = (pred: (x: string) => boolean) => f.findIndex(pred);
    const id = idx((x) => x === 'id' || x === 'kod');
    if (id < 0) continue;
    const title = idx((x) => /gorev|is paketi/.test(x)) >= 0 ? idx((x) => /gorev|is paketi/.test(x)) : idx((x) => /teslimat|kilometre|ad[iı]?$/.test(x));
    const due = idx((x) => x === 'hedef tarih') >= 0 ? idx((x) => x === 'hedef tarih') : idx((x) => x === 'bitis' || x === 'bitis tarihi');
    // A plan has dates. A list with only an id, a name and a status (an agent catalog) is not a plan.
    if (title < 0 || due < 0) continue;
    return { row: r, cols: { id, title, due, owner: idx((x) => /sorumlu|sahip/.test(x)), dep: idx((x) => /bagimlilik/.test(x)), status: idx((x) => x === 'durum'), type: idx((x) => x === 'tip') } };
  }
  return null;
}

/**
 * Read a project plan out of a pre-read workbook with fixed rules. A task row starts with an id such as
 * "W1.4", "0.1" or "T-01" and has a title, a target date and/or a status. Heading rows (one value repeated
 * across merged cells, or a row whose type is "Faz") set the section. When the header lines up with the data
 * its columns are used; when it does not (a header shifted against the rows), columns are found per row.
 */
export function parsePlanSheet(pre: PreRead, year = new Date().getFullYear()): PlanParse {
  const tasks: PlanTask[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const sh of pre.sheets) {
    const planish = PLAN_SHEET.test(fold(sh.name));
    const header = findHeader(sh.rows);
    let section: string | null = null;

    const add = (t: PlanTask) => {
      if (seen.has(t.extId)) { notes.push(`${t.extId} birden fazla kez geçiyor; ilki alındı.`); return; }
      seen.add(t.extId);
      tasks.push(t);
    };

    for (let ri = 0; ri < sh.rows.length; ri++) {
      const row = sh.rows[ri];
      const cells = row.map((c) => c.trim()).filter(Boolean);
      if (!cells.length) continue;

      if (new Set(cells).size === 1 && !ID_RE.test(cells[0]) && cells.length > 1) { section = cells[0]; continue; }
      if (header && ri <= header.row) continue;

      // 1. Header-aligned: every mapped cell must make sense, otherwise this row is read heuristically.
      if (header) {
        const c = header.cols;
        const get = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
        const id = get(c.id);
        if (ID_RE.test(id) && get(c.title)) {
          const stText = get(c.status);
          const status = normalizeStatus(stText);
          const dueText = get(c.due);
          const due = dueText ? parseDate(dueText, { year }) : null;
          if ((status || !stText) && (due || !dueText) && (status || due)) {
            if (fold(get(c.type)) === 'faz') { section = get(c.title); continue; }
            add({ extId: id, section, title: get(c.title), owner: get(c.owner) || null, dependsOn: get(c.dep) && get(c.dep) !== '-' ? get(c.dep) : null, dueDate: due, status: status ?? 'Planlandı' });
            continue;
          }
        }
      }

      // 2. Heuristic: id first, title second; the status word and the LAST date in the row (the end date) are picked out.
      if (cells.length < 3 || !ID_RE.test(cells[0])) continue;
      let status: PlanStatus | null = null;
      let due: string | null = null;
      const middle: string[] = [];
      for (const c of cells.slice(2)) {
        const st: PlanStatus | null = status === null ? normalizeStatus(c) : null;
        if (st) { status = st; continue; }
        const d: string | null = /\d/.test(c) && /[-./]/.test(c) ? parseDate(c, { year }) : null;
        if (d) { due = d; continue; }
        middle.push(c);
      }
      if (!planish && !due) continue; // an agent catalog or similar list, not a plan
      if (!status && !due) continue;
      const [owner, dep] = middle.filter((m) => !/^\d+$/.test(m));
      add({ extId: cells[0], section, title: cells[1], owner: owner && owner !== '-' ? owner : null, dependsOn: dep && dep !== '-' && ID_RE.test(dep.split(/[,\s]/)[0]) ? dep : null, dueDate: due, status: status ?? 'Planlandı' });
    }
  }
  if (!tasks.length) notes.push('Dosyada proje planı satırı (W1.1 gibi kimlik, görev ve tarih) bulunamadı.');
  return { tasks, notes };
}

/* ---------- edits proposed by the assistant: validated here, never trusted ---------- */

export type EditField = 'status' | 'due_date' | 'owner' | 'title' | 'depends_on';

export interface ProposedEdit { ext_id: string; field: EditField; value: string | null }
export interface ProposedNewTask { ext_id: string; section: string | null; title: string; owner: string | null; due_date: string | null; status: string | null; depends_on: string | null }

export interface PlanChange {
  kind: 'update' | 'add';
  extId: string;
  field?: EditField;
  from?: string | null;
  to?: string | null;
  task?: PlanTask;
}

export interface ValidatedEdits { changes: PlanChange[]; rejected: string[] }

/** Keep only edits that name a real task, a real field and a value of the right shape. */
export function validateEdits(current: PlanTask[], edits: ProposedEdit[], added: ProposedNewTask[], year = new Date().getFullYear()): ValidatedEdits {
  const byId = new Map(current.map((t) => [t.extId.toLowerCase(), t]));
  const changes: PlanChange[] = [];
  const rejected: string[] = [];

  for (const e of edits) {
    const t = byId.get(String(e.ext_id).toLowerCase());
    if (!t) { rejected.push(`${e.ext_id}: planda böyle bir görev yok`); continue; }
    let to: string | null;
    let from: string | null;
    switch (e.field) {
      case 'status': {
        const s = normalizeStatus(e.value);
        if (!s) { rejected.push(`${t.extId}: "${e.value}" geçerli bir durum değil`); continue; }
        from = t.status; to = s; break;
      }
      case 'due_date': {
        const d = e.value ? parseDate(e.value, { year }) : null;
        if (e.value && !d) { rejected.push(`${t.extId}: "${e.value}" bir tarih olarak okunamadı`); continue; }
        from = t.dueDate; to = d; break;
      }
      case 'owner': from = t.owner; to = e.value?.trim() || null; break;
      case 'depends_on': from = t.dependsOn; to = e.value?.trim() || null; break;
      case 'title': {
        if (!e.value?.trim()) { rejected.push(`${t.extId}: başlık boş olamaz`); continue; }
        from = t.title; to = e.value.trim(); break;
      }
      default: rejected.push(`${t.extId}: bilinmeyen alan "${e.field}"`); continue;
    }
    if (from !== to) changes.push({ kind: 'update', extId: t.extId, field: e.field, from, to });
  }

  const taken = new Set(byId.keys());
  for (const n of added) {
    const id = String(n.ext_id ?? '').trim();
    if (!ID_RE.test(id)) { rejected.push(`"${id}" geçerli bir görev kimliği değil`); continue; }
    if (taken.has(id.toLowerCase())) { rejected.push(`${id}: bu kimlik zaten var`); continue; }
    if (!n.title?.trim()) { rejected.push(`${id}: başlık boş`); continue; }
    const due = n.due_date ? parseDate(n.due_date, { year }) : null;
    if (n.due_date && !due) { rejected.push(`${id}: tarih okunamadı`); continue; }
    taken.add(id.toLowerCase());
    changes.push({
      kind: 'add', extId: id,
      task: { extId: id, section: n.section, title: n.title.trim(), owner: n.owner?.trim() || null, dependsOn: n.depends_on?.trim() || null, dueDate: due, status: normalizeStatus(n.status) ?? 'Planlandı' },
    });
  }
  return { changes, rejected };
}

export function describeChange(c: PlanChange): string {
  const label: Record<EditField, string> = { status: 'durum', due_date: 'hedef tarih', owner: 'sahip', title: 'başlık', depends_on: 'bağımlılık' };
  if (c.kind === 'add') return `Yeni görev ${c.extId}: ${c.task!.title}${c.task!.dueDate ? ` (${c.task!.dueDate})` : ''}`;
  return `${c.extId} ${label[c.field!]}: ${c.from ?? '–'} → ${c.to ?? '–'}`;
}
