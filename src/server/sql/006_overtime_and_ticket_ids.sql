-- Extra overtime ("ekstra mesai"): the part of an entry outside 09:00–18:00 on a working day, or all of it on a day off.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS overtime_hours numeric(6,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS entries_overtime ON entries (work_date) WHERE overtime_hours > 0 AND NOT deleted;

-- Public holidays: every hour on these days is overtime. The fixed-date national ones are seeded; religious holidays are added by an admin.
CREATE TABLE IF NOT EXISTS holidays (
  date  date PRIMARY KEY,
  name  text NOT NULL
);

-- ITSM identifies a request by an internal id as well as the number people see; details are fetched with it.
ALTER TABLE itsm_tickets ADD COLUMN IF NOT EXISTS sdp_id text;
