import { fold } from './turkish.js';
import type { Candidate, LinkResult, NormalisedRow } from './types.js';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TICKET_RE = /\b([a-z]{2,6})-(\d{3,8})\b/gi;

function bigrams(s: string): Map<string, number> {
  const t = ` ${s} `;
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice on character bigrams, 0..1. Tolerates Turkish suffixes and small typos. */
export function similarity(a: string, b: string): number {
  const x = fold(a).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const y = fold(b).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) ?? 0);
  return (2 * hit) / (x.length + y.length);
}

/** Score of a row's text against one candidate: the best of title match and containment. */
function score(text: string, c: Candidate): number {
  const t = fold(text);
  const title = fold(c.title);
  if (title.length >= 5 && t.includes(title)) return 0.95;
  return Math.max(similarity(text, c.title), similarity(text, `${c.title} ${c.extra ?? ''}`) * 0.9);
}

export interface LinkOptions {
  /** Minimum fuzzy score to link automatically. */
  threshold?: number;
  /** The best score must beat the runner-up by this much. */
  margin?: number;
}

export function linkRow(row: Pick<NormalisedRow, 'description' | 'taskHint' | 'ticketHint' | 'sourceText'>, candidates: Candidate[], opts: LinkOptions = {}): LinkResult {
  const threshold = opts.threshold ?? 0.62;
  const margin = opts.margin ?? 0.12;
  const none: LinkResult = { kind: null, id: null, score: 0, via: 'none', options: [] };
  if (!candidates.length) return none;

  // 1. An explicit id wins outright.
  const idText = `${row.ticketHint ?? ''} ${row.taskHint ?? ''} ${row.description} ${row.sourceText}`;
  for (const m of idText.matchAll(TICKET_RE)) {
    const id = `${m[1]}-${m[2]}`.toLowerCase();
    const hit = candidates.find((c) => c.id.toLowerCase() === id);
    if (hit) return { kind: hit.kind, id: hit.id, score: 1, via: 'explicit-id', options: [] };
  }
  // A bare ticket number: "#20871", "talep 20871", "ticket 20871"
  for (const m of idText.matchAll(/(?:#|\b(?:talep|ticket|bilet|sr|inc)[\s:#-]*)(\d{3,9})\b/gi)) {
    const hit = candidates.find((c) => c.kind === 'itsm' && c.id === m[1]);
    if (hit) return { kind: hit.kind, id: hit.id, score: 1, via: 'explicit-id', options: [] };
  }
  // A project plan code such as W1.4 typed in the text
  for (const c of candidates) {
    if (!c.code) continue;
    const re = new RegExp(`(?<![A-Za-z0-9.])${escapeRe(c.code)}(?![A-Za-z0-9])`, 'i');
    if (re.test(idText)) return { kind: c.kind, id: c.id, score: 1, via: 'explicit-id', options: [] };
  }
  const guid = candidates.find((c) => c.kind === 'planner' && idText.toLowerCase().includes(c.id.toLowerCase()));
  if (guid) return { kind: guid.kind, id: guid.id, score: 1, via: 'explicit-id', options: [] };

  // 2. Exact title.
  const wanted = [row.taskHint, row.description].filter((s): s is string => !!s);
  for (const w of wanted) {
    const hit = candidates.filter((c) => fold(c.title) === fold(w));
    if (hit.length === 1) return { kind: hit[0].kind, id: hit[0].id, score: 1, via: 'exact-title', options: [] };
  }

  // 3. Fuzzy. A task hint is stronger evidence than the free description.
  const scored = candidates
    .map((c) => ({ c, s: Math.max(row.taskHint ? score(row.taskHint, c) : 0, score(row.description, c) * (row.taskHint ? 0.9 : 1)) }))
    .sort((a, b) => b.s - a.s);
  const [best, second] = scored;
  const options = scored.filter((x) => x.s >= 0.25).slice(0, 5).map((x) => x.c);
  if (best && best.s >= threshold && best.s - (second?.s ?? 0) >= margin) {
    return { kind: best.c.kind, id: best.c.id, score: Math.round(best.s * 100) / 100, via: 'fuzzy', options: [] };
  }
  return { ...none, score: best ? Math.round(best.s * 100) / 100 : 0, options };
}

/** Accept the model's pick only when it is one of the candidates it was shown. */
export function acceptModelPick(pickedId: string | null | undefined, options: Candidate[]): Candidate | null {
  if (!pickedId) return null;
  return options.find((c) => c.id === pickedId) ?? null;
}
