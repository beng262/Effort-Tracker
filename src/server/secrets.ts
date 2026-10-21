import { config } from './config.js';

export interface VaultSecret { value: string; updatedAt: string | null }

/** The few secrets the app manages itself. Everything else in the vault stays read-only to it. */
export const MANAGED_SECRETS = ['itsm-api-key'] as const;
export type ManagedSecret = (typeof MANAGED_SECRETS)[number];

export interface Vault {
  get(name: ManagedSecret): Promise<VaultSecret | null>;
  set(name: ManagedSecret, value: string): Promise<void>;
}

interface VaultOptions {
  vaultName?: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/**
 * Azure Key Vault through the web app's managed identity (no keys, no extra packages).
 * Without a vault name (local runs, tests) it falls back to memory, so nothing ever leaves the process.
 */
export function createVault(o: VaultOptions = {}): Vault {
  const name = o.vaultName ?? config.KEY_VAULT_NAME;
  if (!name) return memoryVault();
  const f = o.fetchImpl ?? fetch;
  const env = o.env ?? process.env;
  const base = `https://${name}.vault.azure.net`;
  let token: { value: string; exp: number } | null = null;

  async function bearer(): Promise<string> {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const endpoint = env.IDENTITY_ENDPOINT;
    const header = env.IDENTITY_HEADER;
    if (!endpoint || !header) throw new Error('Yönetilen kimlik (managed identity) bulunamadı; Key Vault yalnızca Azure üzerinde kullanılabilir.');
    const r = await f(`${endpoint}?resource=${encodeURIComponent('https://vault.azure.net')}&api-version=2019-08-01`, { headers: { 'X-IDENTITY-HEADER': header } });
    const b: any = await r.json().catch(() => null);
    if (!r.ok || !b?.access_token) throw new Error(`Key Vault erişim belirteci alınamadı (${r.status}).`);
    token = { value: b.access_token, exp: Number(b.expires_on) * 1000 || Date.now() + 30 * 60_000 };
    return token.value;
  }

  return {
    async get(secret) {
      const r = await f(`${base}/secrets/${secret}?api-version=7.4`, { headers: { authorization: `Bearer ${await bearer()}` } });
      if (r.status === 404) return null;
      const b: any = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`Key Vault okuma hatası (${r.status}): ${b?.error?.message ?? ''}`.slice(0, 240));
      return { value: String(b.value), updatedAt: b.attributes?.updated ? new Date(b.attributes.updated * 1000).toISOString() : null };
    },
    async set(secret, value) {
      const r = await f(`${base}/secrets/${secret}?api-version=7.4`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!r.ok) {
        const b: any = await r.json().catch(() => null);
        // The message never contains the secret; it only says what the vault refused.
        throw new Error(`Key Vault yazma hatası (${r.status}): ${b?.error?.message ?? ''}`.slice(0, 240));
      }
    },
  };
}

export function memoryVault(): Vault {
  const m = new Map<string, VaultSecret>();
  return {
    async get(n) { return m.get(n) ?? null; },
    async set(n, v) { m.set(n, { value: v, updatedAt: new Date().toISOString() }); },
  };
}
