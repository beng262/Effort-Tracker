// ITSM connector. The ticket system named in the team's own plan is an ITSM tool,
// so the first implementation speaks its REST API v3 (read-only). Anything else can implement `Itsm`.
// Writing hours back to tickets as worklogs is NOT built and stays off until the owner decides.

import { config } from './config.js';
import type { Vault } from './secrets.js';
import type { Db } from './db.js';

export interface ItsmTicket {
  id: string;
  /** ITSM internal id, needed to open the full request. */
  sdpId: string | null;
  title: string;
  customer: string | null;
  assignee: string | null; // the technician's e-mail, lower-case: matched to employees by address
  status: string | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface Itsm {
  /** Tickets created or changed since `since`. */
  listChangedSince(since: Date): Promise<ItsmTicket[]>;
  getTicket(id: string): Promise<ItsmTicket | null>;
  /** The full request for the details panel, looked up by the number people see (and the internal id when known). */
  detail(displayId: string, sdpId?: string | null): Promise<TicketDetail | null>;
}

export interface TicketDetail {
  no: string;
  sdpId: string;
  title: string;
  description: string;
  status: string | null;
  priority: string | null;
  urgency: string | null;
  impact: string | null;
  category: string | null;
  subcategory: string | null;
  requestType: string | null;
  requester: { name: string | null; email: string | null; department: string | null };
  technician: { name: string | null; email: string | null };
  group: string | null;
  site: string | null;
  customer: string | null;
  createdAt: string | null;
  dueAt: string | null;
  respondedAt: string | null;
  resolvedAt: string | null;
  completedAt: string | null;
  overdue: boolean | null;
  resolution: string | null;
  /** Opens the request in ITSM itself. */
  url: string | null;
}

/** ITSM keeps descriptions as HTML. Show them as text: line breaks kept, tags and entities gone. */
export function htmlToText(html: unknown): string {
  return String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const name = (o: any): string | null => (o?.name ? String(o.name) : null);

export function mapSdpDetail(r: any, baseUrl: string): TicketDetail {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    no: String(r.display_id ?? r.id),
    sdpId: String(r.id),
    title: String(r.subject ?? '').trim() || '(konu yok)',
    description: htmlToText(r.description),
    status: name(r.status),
    priority: name(r.priority), urgency: name(r.urgency), impact: name(r.impact),
    category: name(r.category), subcategory: name(r.subcategory), requestType: name(r.request_type),
    requester: { name: name(r.requester), email: r.requester?.email_id ?? null, department: name(r.requester?.department) },
    technician: { name: name(r.technician), email: r.technician?.email_id ?? null },
    group: name(r.group), site: name(r.site),
    customer: r.account?.name ?? r.site?.name ?? r.requester?.department?.name ?? null,
    createdAt: msToIso(r.created_time?.value), dueAt: msToIso(r.due_by_time?.value), respondedAt: msToIso(r.responded_time?.value),
    resolvedAt: msToIso(r.resolved_time?.value), completedAt: msToIso(r.completed_time?.value),
    overdue: typeof r.is_overdue === 'boolean' ? r.is_overdue : null,
    resolution: r.resolution?.content ? htmlToText(r.resolution.content) : null,
    url: `${base}/WorkOrder.do?woMode=viewWO&woID=${encodeURIComponent(String(r.id))}`,
  };
}

const msToIso = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

/** One ITSM request object → a ticket. Field names differ a little between cloud and on-premise. */
export function mapSdpRequest(r: any): ItsmTicket {
  return {
    id: String(r.display_id ?? r.id),
    sdpId: r.id !== undefined ? String(r.id) : null,
    title: String(r.subject ?? '').trim() || '(konu yok)',
    customer: r.account?.name ?? r.site?.name ?? r.requester?.department?.name ?? null,
    assignee: (r.technician?.email_id ?? r.technician?.email ?? null)?.toLowerCase?.() ?? null,
    status: r.status?.name ?? null,
    openedAt: msToIso(r.created_time?.value),
    closedAt: msToIso(r.completed_time?.value),
  };
}

export interface SdpOptions {
  baseUrl: string;
  apiKey: string;
  /** Some installations want the key in `TECHNICIAN_KEY`, most in `authtoken`. */
  header?: 'authtoken' | 'TECHNICIAN_KEY';
  fetchImpl?: typeof fetch;
  pageSize?: number;
}

export function createItsmClient(o: SdpOptions): Itsm {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  const size = o.pageSize ?? 100;
  const headers = { [o.header ?? 'authtoken']: o.apiKey, Accept: 'application/json' };

  async function get(path: string, inputData?: unknown): Promise<any> {
    const url = `${base}/api/v3/${path}` + (inputData ? `?input_data=${encodeURIComponent(JSON.stringify(inputData))}` : '');
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await f(url, { headers });
      if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
      const body: any = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`ITSM ${r.status}: ${JSON.stringify(body?.response_status?.messages ?? body ?? {}).slice(0, 200)}`);
      const code = body?.response_status?.status_code;
      if (code !== undefined && code !== 2000) throw new Error(`ITSM status ${code}: ${JSON.stringify(body.response_status.messages ?? []).slice(0, 200)}`);
      return body;
    }
    throw new Error(`ITSM gave up: ${path}`);
  }

  return {
    async listChangedSince(since) {
      const out: ItsmTicket[] = [];
      for (let start = 1; ; start += size) {
        const body = await get('requests', {
          list_info: {
            row_count: size, start_index: start, sort_field: 'last_updated_time', sort_order: 'asc', get_total_count: false,
            search_criteria: [{ field: 'last_updated_time', condition: 'greater than', value: String(since.getTime()) }],
          },
        });
        for (const r of body.requests ?? []) out.push(mapSdpRequest(r));
        if (!body.list_info?.has_more_rows) break;
        if (start > 100_000) throw new Error('ITSM: too many pages');
      }
      return out;
    },
    async detail(displayId, sdpId) {
      const fetchOne = async (id: string): Promise<TicketDetail | null> => {
        try { return mapSdpDetail((await get(`requests/${encodeURIComponent(id)}`)).request, base); }
        catch (e) { if (/ (404|400)/.test((e as Error).message)) return null; throw e; }
      };
      if (sdpId) return fetchOne(sdpId);
      // On some installations the number people see IS the request id (ours does): ask for it directly, and only trust the answer if it is that ticket.
      const direct = await fetchOne(displayId);
      if (direct && direct.no === String(displayId)) return direct;
      // Others keep a separate display id; look the internal id up.
      try {
        const found = await get('requests', { list_info: { row_count: 1, start_index: 1, search_criteria: [{ field: 'display_id', condition: 'is', value: String(displayId) }] } });
        const id = found.requests?.[0]?.id ? String(found.requests[0].id) : null;
        return id ? fetchOne(id) : null;
      } catch (e) { if (/ (400|404)|status 4/.test((e as Error).message)) return null; throw e; }
    },

    async getTicket(id) {
      try { return mapSdpRequest((await get(`requests/${encodeURIComponent(id)}`)).request); }
      catch (e) { if (/ 404/.test((e as Error).message)) return null; throw e; }
    },
  };
}

/** Where the ticket system is and who uses it. The API key is not here: it lives in Key Vault. */
export interface ItsmSetup {
  baseUrl: string | null;
  tenantId: string | null;
  make(key: string): Itsm | null;
}

export function itsmSetupFromConfig(): ItsmSetup {
  const baseUrl = config.ITSM_BASE_URL?.trim() || null;
  return {
    baseUrl,
    tenantId: config.ITSM_TENANT_ID?.trim() || null,
    make: (key) => (baseUrl ? createItsmClient({ baseUrl, apiKey: key, header: config.ITSM_AUTH_HEADER }) : null),
  };
}

let keyCache: { at: number; key: string | null; updatedAt: string | null } | null = null;
/** Forget the cached key (after it was replaced). */
export function forgetItsmKey(): void { keyCache = null; }

/** The current API key: Key Vault first, then the old environment variable. Cached for a few minutes. */
export async function currentItsmKey(vault: Vault): Promise<{ key: string | null; updatedAt: string | null }> {
  if (keyCache && Date.now() - keyCache.at < 5 * 60_000) return keyCache;
  let key: string | null = null;
  let updatedAt: string | null = null;
  try {
    const s = await vault.get('itsm-api-key');
    if (s) { key = s.value; updatedAt = s.updatedAt; }
  } catch (e) {
    console.error('ITSM key could not be read from Key Vault', e);
  }
  key ??= config.ITSM_API_KEY?.trim() || null;
  keyCache = { at: Date.now(), key, updatedAt };
  return keyCache;
}

/** The connector, or null until the address, the tenant and a key are all there. */
export async function loadItsm(setup: ItsmSetup, vault: Vault): Promise<Itsm | null> {
  if (!setup.baseUrl || !setup.tenantId) return null;
  const { key } = await currentItsmKey(vault);
  return key ? setup.make(key) : null;
}

export async function syncTickets(db: Db, itsm: Itsm, tenantId: string, since: Date): Promise<number> {
  const tickets = await itsm.listChangedSince(since);
  await db.tx(async (t) => {
    await t.query(`UPDATE tenants SET itsm_enabled = true WHERE id = $1`, [tenantId]);
    for (const k of tickets) {
      await t.query(
        `INSERT INTO itsm_tickets (id, tenant_id, title, customer, assignee, status, opened_at, closed_at, synced_at, sdp_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, customer=EXCLUDED.customer, assignee=EXCLUDED.assignee,
           status=EXCLUDED.status, opened_at=EXCLUDED.opened_at, closed_at=EXCLUDED.closed_at, synced_at=now(), sdp_id=coalesce(EXCLUDED.sdp_id, itsm_tickets.sdp_id)`,
        [k.id, tenantId, k.title, k.customer, k.assignee, k.status, k.openedAt, k.closedAt, k.sdpId]);
    }
  });
  return tickets.length;
}

/**
 * Sync now. The first run reads the last 90 days; later runs read from just before the previous run,
 * so a ticket changed while a run was in progress is not missed. The result is recorded for the status page.
 */
export async function runItsmSync(db: Db, itsm: Itsm, tenantId: string): Promise<{ tickets: number; since: string; error?: string }> {
  const last = (await db.query<{ last_detail: string | null; last_status: string | null }>(`SELECT last_detail, last_status FROM job_runs WHERE name='itsm-sync'`)).rows[0];
  const prev = last?.last_status === 'ok' && last.last_detail ? new Date(JSON.parse(last.last_detail).startedAt) : null;
  const since = prev ? new Date(prev.getTime() - 10 * 60_000) : new Date(Date.now() - 90 * 86_400_000);
  const startedAt = new Date().toISOString();
  try {
    const tickets = await syncTickets(db, itsm, tenantId, since);
    await db.query(`INSERT INTO job_runs (name,last_run_at,last_status,last_detail) VALUES ('itsm-sync',now(),'ok',$1)
                    ON CONFLICT (name) DO UPDATE SET last_run_at=now(), last_status='ok', last_detail=$1`, [JSON.stringify({ startedAt, tickets })]);
    return { tickets, since: since.toISOString() };
  } catch (e) {
    await db.query(`INSERT INTO job_runs (name,last_run_at,last_status,last_detail) VALUES ('itsm-sync',now(),'error',$1)
                    ON CONFLICT (name) DO UPDATE SET last_run_at=now(), last_status='error', last_detail=$1`, [JSON.stringify({ error: (e as Error).message })]);
    return { tickets: 0, since: since.toISOString(), error: (e as Error).message };
  }
}
