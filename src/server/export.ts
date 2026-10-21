import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { ReportResult } from './reports.js';

const require = createRequire(import.meta.url);
const font = (w: 400 | 700, subset: 'latin' | 'latin-ext') => require.resolve(`@fontsource/roboto/files/roboto-${subset}-${w}-normal.woff`);

const stamp = (r: ReportResult) => new Date(r.generatedAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

/** Excel with a live SUM so totals can be checked by hand, and a sheet stating filters and run time. */
export async function reportToXlsx(r: ReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rapor');
  ws.addRow(r.columns.map((c) => c.label)).font = { bold: true };
  for (const row of r.rows) ws.addRow(r.columns.map((c) => row[c.key] ?? ''));
  const hoursIdx = r.columns.findIndex((c) => c.key === 'hours' || c.key === 'missing');
  if (hoursIdx >= 0 && r.rows.length) {
    const col = ws.getColumn(hoursIdx + 1).letter;
    const total = ws.addRow(r.columns.map((_, i) => (i === 0 ? 'Toplam' : '')));
    total.getCell(hoursIdx + 1).value = { formula: `SUM(${col}2:${col}${r.rows.length + 1})`, result: r.total };
    const otIdx = r.columns.findIndex((c) => c.key === 'overtime');
    if (otIdx >= 0) {
      const oc = ws.getColumn(otIdx + 1).letter;
      total.getCell(otIdx + 1).value = { formula: `SUM(${oc}2:${oc}${r.rows.length + 1})`, result: r.overtime };
    }
    const entriesIdx = r.columns.findIndex((c) => c.key === 'entries');
    if (entriesIdx >= 0) {
      const ec = ws.getColumn(entriesIdx + 1).letter;
      total.getCell(entriesIdx + 1).value = { formula: `SUM(${ec}2:${ec}${r.rows.length + 1})`, result: r.entries };
    }
    total.font = { bold: true };
  }
  ws.columns.forEach((c) => { c.width = 24; });
  const info = wb.addWorksheet('Bilgi');
  info.addRows([['Rapor', r.title], ['Dönem', `${r.from} – ${r.to}`], ['Filtreler', r.filters.join('; ') || 'yok'], ['Çalıştırılma', stamp(r)], ['Yalnızca onaylanmış kayıtlar sayılır', '']]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Ğ ğ İ ı Ş ş live in the latin-ext subset; everything else Turkish is in latin. */
const EXT = /[ĞğİıŞş]/;
function runs(text: string): { t: string; ext: boolean }[] {
  const out: { t: string; ext: boolean }[] = [];
  for (const ch of text) {
    const ext = EXT.test(ch);
    const last = out[out.length - 1];
    if (last && last.ext === ext) last.t += ch;
    else out.push({ t: ch, ext });
  }
  return out;
}

export async function reportToPdf(r: ReportResult): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((ok) => doc.on('end', () => ok(Buffer.concat(chunks))));
  const put = (text: string, x: number, y: number, w: number, bold = false) => {
    const rs = runs(text);
    rs.forEach((run, i) => {
      doc.font(font(bold ? 700 : 400, run.ext ? 'latin-ext' : 'latin'));
      doc.text(run.t, i === 0 ? x : undefined, i === 0 ? y : undefined, { width: w, continued: i < rs.length - 1, lineBreak: false, ellipsis: true });
    });
  };

  doc.fontSize(16); put(r.title, 40, 40, 515, true);
  doc.fontSize(9);
  put(`Dönem: ${r.from} – ${r.to}`, 40, 66, 515);
  put(`Filtreler: ${r.filters.join('; ') || 'yok'}   ·   Çalıştırılma: ${stamp(r)}`, 40, 78, 515);
  const colW = 515 / r.columns.length;
  let y = 104;
  const line = (cells: string[], bold: boolean) => {
    if (y > 780) { doc.addPage(); y = 40; }
    cells.forEach((c, i) => put(c, 40 + i * colW, y, colW - 6, bold));
    y += 14;
  };
  doc.fontSize(9);
  line(r.columns.map((c) => c.label), true);
  for (const row of r.rows) line(r.columns.map((c) => String(row[c.key] ?? '')), false);
  if (r.rows.length) line(r.columns.map((c, i) => (i === 0 ? 'Toplam' : c.key === 'hours' || c.key === 'missing' ? String(r.total) : c.key === 'overtime' ? String(r.overtime) : c.key === 'entries' ? String(r.entries) : '')), true);
  doc.end();
  return done;
}
