import { z } from 'zod';

const env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().default('dev-only-change-me'),

  // Entra: one multi-tenant app registration, allowlisted to exactly these tenants.
  AUTH_MODE: z.enum(['entra', 'dev']).default('entra'),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ALLOWED_TENANTS: z.string().default(''), // "tenantId:Alpha:alpha.example.com,tenantId:Beta:beta.example.com"

  // Azure OpenAI (the shared OpenAI resource, GPT-6 Sol). The key goes in Key Vault in production.
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().default('gpt-6-sol'),
  AZURE_OPENAI_API_VERSION: z.string().default('2025-04-01-preview'),

  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  BLOB_CONTAINER: z.string().default('efor-uploads'),
  LOCAL_UPLOAD_DIR: z.string().default('.data/uploads'),

  SYNC_ENABLED: z.coerce.boolean().default(false),
  SYNC_INTERVAL_MIN: z.coerce.number().default(30),
  SCHEDULER_ENABLED: z.coerce.boolean().default(false),
  // Largest single file a person can add to a project, in megabytes.
  PROJECT_FILE_MAX_MB: z.coerce.number().positive().default(25),
  // Calendar meetings as effort (delegated Graph permission Calendars.Read). Off until the app registration has the permission.
  CALENDAR_ENABLED: z.string().default('').transform((v) => /^(1|true|yes|on)$/i.test(v)),

  // ITSM (an ITSM tool). Blank = the connector is off.
  ITSM_BASE_URL: z.string().optional(),
  ITSM_API_KEY: z.string().optional(),
  ITSM_AUTH_HEADER: z.enum(['authtoken', 'TECHNICIAN_KEY']).default('authtoken'),
  ITSM_TENANT_ID: z.string().optional(),
  KEY_VAULT_NAME: z.string().optional(), // the app reads and writes its own managed secrets here (itsm-api-key) // the tenant whose people use the ticket system (Beta)

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('efor@alpha.example.com'),

  DEFAULT_DAY_HOURS: z.coerce.number().default(8),
  // Working hours: everything outside this window (and on weekends and holidays) is extra overtime.
  WORK_START: z.string().regex(/^\d{1,2}:\d{2}$/).default('09:00'),
  WORK_END: z.string().regex(/^\d{1,2}:\d{2}$/).default('18:00'),
});

export const config = env.parse(process.env);
export const isProd = config.NODE_ENV === 'production';

export interface AllowedTenant { id: string; name: string; domain: string }

export function allowedTenants(raw = config.ALLOWED_TENANTS): AllowedTenant[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [id, name, domain] = s.split(':');
    return { id: id.toLowerCase(), name: name ?? id, domain: domain ?? '' };
  });
}

if (isProd && config.AUTH_MODE === 'dev') throw new Error('AUTH_MODE=dev is not allowed in production');
if (isProd && config.SESSION_SECRET === 'dev-only-change-me') throw new Error('SESSION_SECRET must be set in production');
