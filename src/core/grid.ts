import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { fold } from './turkish.js';
import type { ColumnMapping, ProposedRow } from './types.js';

export interface Sheet {
  name: string;
  /** rows[r][c] is the display text of the cell at row r+1, column c+1; '' when empty. */
  rows: string[][];
  /** Row numbers (1-based) that were hidden and left out. */
  hiddenRows: number[];
}

export interface PreRead {
  kind: 'excel' | 'csv' | 'text';
  sheets: Sheet[];
  /** Compact text the model can cite from; cell addresses or line numbers on every line. */
  compact: string;
  truncated: boolean;
}

const MAX_ROWS_PER_SHEET = 400;
const MAX_COMPACT_CHARS = 60_000;

export function colLetter(index0: number): string {
  let n = index0 + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const pad = (n: number) => String(n).padStart(2, '0');

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Excel stores a bare time (or duration) as a day fraction on 1899-12-30.
    if (v.getUTCFullYear() < 1905) {
      const mins = Math.round(((v.getTime() - Date.UTC(1899, 11, 30)) / 60000));
      return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    }
    const day = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    return v.getUTCHours() || v.getUTCMinutes() ? `${day} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : day;
  }
  if (typeof v === 'object') {
    if ('result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
    return '';
  }
  return String(v).trim();
}

export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    // Notepad's "ANSI" on a Turkish Windows is windows-1254.
    return new TextDecoder('windows-1254').decode(buf);
  }
}

export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim());
      cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export async function preRead(fileName: string, buf: Buffer): Promise<PreRead> {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'xlsx' || ext === 'xlsm') return preReadExcel(buf);
  if (ext === 'xls') throw new Error('Eski .xls biçimi desteklenmiyor. Dosyayı Excel\'de .xlsx olarak kaydedip tekrar yükleyin.');
  if (ext === 'csv') return fromSheets('csv', [{ name: 'csv', rows: parseCsv(decodeText(buf)), hiddenRows: [] }]);
  const text = decodeText(buf);
  const lines = text.split(/\r?\n/);
  const compactLines: string[] = [];
  lines.forEach((l, i) => { if (l.trim()) compactLines.push(`L${i + 1}: ${l.trimEnd()}`); });
  let compact = compactLines.join('\n');
  let truncated = false;
  if (compact.length > MAX_COMPACT_CHARS) { compact = compact.slice(0, MAX_COMPACT_CHARS); truncated = true; }
  return { kind: 'text', sheets: [{ name: 'text', rows: lines.map((l) => [l]), hiddenRows: [] }], compact, truncated };
}

async function preReadExcel(buf: Buffer): Promise<PreRead> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    if (ws.state === 'hidden' || ws.state === 'veryHidden') return;
    const rows: string[][] = [];
    const hiddenRows: number[] = [];
    const hiddenCols = new Set<number>();
    ws.columns?.forEach((c, i) => { if (c?.hidden) hiddenCols.add(i); });
    const maxCol = ws.columnCount;
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (row.hidden) { hiddenRows.push(r); rows.push([]); continue; }
      const out: string[] = [];
      for (let c = 1; c <= maxCol; c++) out.push(hiddenCols.has(c - 1) ? '' : cellText(row.getCell(c).value));
      rows.push(out);
    }
    sheets.push({ name: ws.name, rows, hiddenRows });
  });
  return fromSheets('excel', sheets);
}

function fromSheets(kind: 'excel' | 'csv', sheets: Sheet[]): PreRead {
  const out: string[] = [];
  let truncated = false;
  for (const sh of sheets) {
    out.push(`## Sheet "${sh.name}"`);
    let shown = 0;
    for (let r = 0; r < sh.rows.length; r++) {
      const cells = sh.rows[r]
        .map((v, c) => (v === '' ? '' : `${colLetter(c)}=${v}`))
        .filter(Boolean);
      if (!cells.length) continue;
      if (++shown > MAX_ROWS_PER_SHEET) { truncated = true; out.push('…(more rows left out)'); break; }
      out.push(`R${r + 1}: ${cells.join(' | ')}`);
    }
  }
  let compact = out.join('\n');
  if (compact.length > MAX_COMPACT_CHARS) { compact = compact.slice(0, MAX_COMPACT_CHARS); truncated = true; }
  return { kind, sheets, compact, truncated };
}

/** First row with at least three non-empty text cells that is not a date or number: the header. */
export function detectHeaderRow(sh: Sheet): number | null {
  for (let r = 0; r < Math.min(sh.rows.length, 30); r++) {
    const texts = sh.rows[r].filter((v) => v !== '' && Number.isNaN(Number(v.replace(',', '.'))) && !/^\d{4}-\d\d-\d\d$/.test(v));
    if (texts.length >= 3) return r + 1;
  }
  return null;
}

/** Same layout ⇒ same fingerprint, regardless of the data underneath or who the sheet belongs to. */
export function layoutFingerprint(pre: PreRead): string | null {
  if (pre.kind === 'text') return null;
  const parts: string[] = [];
  for (const sh of [...pre.sheets].sort((a, b) => a.name.localeCompare(b.name))) {
    const h = detectHeaderRow(sh);
    if (h === null) continue;
    const header = sh.rows[h - 1].map(fold).filter(Boolean).join('|');
    parts.push(`${fold(sh.name)}@${h}:${header}`);
  }
  if (!parts.length) return null;
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

/**
 * Apply a saved column mapping with no model call. Returns proposed rows in the same shape
 * the model would have produced, so the rest of the pipeline is identical.
 */
export function applyMappings(pre: PreRead, mappings: ColumnMapping[]): ProposedRow[] {
  const out: ProposedRow[] = [];
  for (const map of mappings) {
    const sh = pre.sheets.find((s) => fold(s.name) === fold(map.sheet));
    if (!sh) continue;
    const get = (row: string[], col: string | null) => (col ? row[colIndex(col)] ?? '' : '');
    for (let r = map.header_row; r < sh.rows.length; r++) {
      const row = sh.rows[r];
      if (!row || !row.some((v) => v !== '')) continue;
      const rowNo = r + 1;
      const date = get(row, map.date);
      const start = get(row, map.start);
      const end = get(row, map.end);
      const effort = get(row, map.effort);
      const description = get(row, map.description);
      if (!date && !effort && !description && !start) continue;
      const time = start && end ? `${start}-${end}` : start || null;
      const addr = (col: string | null) => (col ? `${sh.name}!${col.toUpperCase()}${rowNo}` : `${sh.name}!R${rowNo}`);
      out.push({
        date: date || null,
        time,
        effort: effort || null,
        description,
        task_hint: get(row, map.task) || null,
        ticket_hint: get(row, map.ticket) || null,
        project_hint: get(row, map.project) || null,
        leave: false,
        confidence: 1,
        source: addr(map.effort ?? map.description ?? map.date),
        source_text: row.filter(Boolean).join(' | '),
      });
    }
  }
  return out;
}
