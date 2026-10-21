import { fold, formatClock, parseClock } from './turkish.js';
import { colLetter, type PreRead } from './grid.js';
import type { ProposedRow, RowExtras } from './types.js';

/** The standard daily effort form people fill in ("Gunluk_Efor_Giris_Sablonu.xlsx"). */
export const STANDARD_SHEET = 'Günlük Efor Girişi';

export const CATEGORIES = ['SLA', 'Proje', 'Satış Destek', 'Teknik Çözüm / Ar-Ge', 'İç Operasyon', 'Eğitim / Gelişim'] as const;

const PROGRESS = [['Tamamlandı', /^(tamamland|bitti|tamam|done)/], ['Devam Ediyor', /^(devam|surec)/], ['Bloke', /^(bloke|engel|blocked)/]] as const;

/** Header text (folded) → field. Matched by name, so reordered columns still work. */
const COLUMNS: Record<string, keyof StandardCols> = {
  'tarih': 'date', 'calisan': 'employee', 'is kategorisi': 'category', 'musteri / ic calisma': 'customer',
  'proje / sla / firsat adi': 'workItem', 'urun / teknoloji': 'product', 'yapilan calisma': 'description',
  'baslangic': 'start', 'bitis': 'end', 'sure (saat)': 'hours', 'sonuc / cikti': 'outcome', 'devam durumu': 'progress',
};

interface StandardCols { date: number; employee: number; category: number; customer: number; workItem: number; product: number; description: number; start: number; end: number; hours: number; outcome: number; progress: number }

export interface StandardRow extends ProposedRow {
  extras: RowExtras;
  /** The name typed in the "Çalışan" column. */
  employee: string | null;
}

export interface StandardParse { rows: StandardRow[]; notes: string[] }

/** Canonical category for what was typed ("sla", "Teknik Cozum / Ar-Ge"), or null when it is not one of the six. */
export function canonicalCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const f = fold(raw);
  return CATEGORIES.find((c) => fold(c) === f) ?? null;
}

export function normaliseProgress(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const f = fold(s);
  return PROGRESS.find(([, re]) => re.test(f))?.[0] ?? s;
}

/** "2026-10-13 09:00", "09:00", "9.30" → "09:00". */
function clockOf(cell: string): string | null {
  const t = cell.trim();
  if (!t) return null;
  const m = t.match(/(\d{1,2}[:.]\d{2})\s*$/) ?? t.match(/^(\d{1,2})$/);
  if (!m) return null;
  const mins = parseClock(m[1]);
  return mins === null ? null : formatClock(mins);
}

function findHeader(rows: string[][]): { row: number; cols: StandardCols } | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const found: Partial<StandardCols> = {};
    rows[r].forEach((c, i) => { const k = COLUMNS[fold(c).replace(/\s+/g, ' ')]; if (k && found[k] === undefined) found[k] = i; });
    // The form is recognised by its core columns; the rest may be missing or moved.
    if (found.date !== undefined && found.description !== undefined && found.category !== undefined && (found.hours !== undefined || (found.start !== undefined && found.end !== undefined))) {
      const all = {} as StandardCols;
      for (const k of Object.values(COLUMNS)) all[k] = found[k] ?? -1;
      return { row: r, cols: all };
    }
  }
  return null;
}

/**
 * Read the standard form with fixed rules, no model. Returns null when the workbook is not the form.
 * Empty rows (only the pre-filled duration formula) and the sample rows ("Örnek Kullanıcı") are left out.
 */
export function parseStandardSheet(pre: PreRead): StandardParse | null {
  for (const sh of pre.sheets) {
    const header = findHeader(sh.rows);
    if (!header) continue;
    const c = header.cols;
    const get = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    const rows: StandardRow[] = [];
    const notes: string[] = [];
    let samples = 0;

    for (let ri = header.row + 1; ri < sh.rows.length; ri++) {
      const row = sh.rows[ri];
      if (!row) continue;
      const keyCells = [c.date, c.employee, c.category, c.customer, c.workItem, c.product, c.description, c.start, c.end, c.outcome].map((i) => get(row, i));
      if (keyCells.every((x) => !x)) continue; // a pre-formatted blank line: only the duration formula is there
      if (fold(get(row, c.employee)) === 'ornek kullanici') { samples++; continue; }

      const start = clockOf(get(row, c.start));
      const end = clockOf(get(row, c.end));
      const hoursCell = get(row, c.hours);
      const category = get(row, c.category);
      const rowNo = ri + 1;
      rows.push({
        date: get(row, c.date) || null,
        time: start && end ? `${start}-${end}` : null,
        effort: hoursCell || null,
        description: get(row, c.description),
        task_hint: null, ticket_hint: null,
        // The project / SLA / opportunity name is what ties the row to an Efor project.
        project_hint: get(row, c.workItem) || get(row, c.customer) || null,
        leave: false,
        confidence: 1,
        source: `${sh.name}!${colLetter(c.description >= 0 ? c.description : 6)}${rowNo}`,
        source_text: row.map((x) => x.trim()).filter(Boolean).join(' | '),
        employee: get(row, c.employee) || null,
        extras: {
          category: canonicalCategory(category) ?? (category || null),
          customer: get(row, c.customer) || null,
          work_item: get(row, c.workItem) || null,
          product: get(row, c.product) || null,
          outcome: get(row, c.outcome) || null,
          progress: normaliseProgress(get(row, c.progress)),
        },
      });
    }
    if (samples) notes.push(`${samples} örnek satır (“Örnek Kullanıcı”) atlandı.`);
    if (!rows.length) notes.push('Formda doldurulmuş satır bulunamadı.');
    return { rows, notes };
  }
  return null;
}

/** Same person? "Murat Aydın" ≈ "murat aydin" ≈ "Murat". Every word of the shorter name must be in the longer. */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true; // nothing to compare
  const A = fold(a).split(/\s+/).filter(Boolean);
  const B = fold(b).split(/\s+/).filter(Boolean);
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  return short.every((w) => long.some((x) => x === w || x.startsWith(w) || w.startsWith(x)));
}
