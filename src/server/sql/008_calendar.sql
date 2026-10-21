-- Calendar connection (delegated Microsoft Graph, Calendars.Read): one refresh token per person.
-- The token is sealed with AES-256-GCM before it is stored; the key is derived from the app's session secret.
CREATE TABLE IF NOT EXISTS calendar_connections (
  employee_id   uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  tenant_id     text NOT NULL,
  refresh_token text NOT NULL,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- An effort row that came from a calendar meeting remembers which one, so it is never added twice.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS external_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS entries_external_ref ON entries (employee_id, external_ref) WHERE external_ref IS NOT NULL AND NOT deleted;
