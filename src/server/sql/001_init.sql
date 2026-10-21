-- Effort Tracker schema. ITSM tables are included now so the connector can be added without a migration.

CREATE TABLE IF NOT EXISTS tenants (
  id            text PRIMARY KEY,                 -- Entra tenant id
  name          text NOT NULL,
  domain        text NOT NULL,
  graph_state   text NOT NULL DEFAULT 'unknown',  -- unknown | consented | error
  graph_checked_at timestamptz,
  itsm_enabled  boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS employees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  day_hours     numeric(4,2) NOT NULL DEFAULT 8,
  active        boolean NOT NULL DEFAULT true,
  role          text NOT NULL DEFAULT 'Employee' CHECK (role IN ('Employee','PM','Admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One employee can have an account in both tenants; both point at the same row.
CREATE TABLE IF NOT EXISTS identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  email         text NOT NULL,
  entra_oid     text,
  itsm_user_id  text,
  UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX IF NOT EXISTS identities_oid ON identities (tenant_id, entra_oid) WHERE entra_oid IS NOT NULL;

CREATE TABLE IF NOT EXISTS projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  code          text,
  customer      text,
  tenant_id     text REFERENCES tenants(id),
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES employees(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_plans (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  plan_id       text NOT NULL,
  plan_title    text,
  PRIMARY KEY (tenant_id, plan_id)
);

CREATE TABLE IF NOT EXISTS employee_projects (
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (employee_id, project_id)
);

CREATE TABLE IF NOT EXISTS planner_tasks (
  tenant_id     text NOT NULL REFERENCES tenants(id),
  id            text NOT NULL,
  plan_id       text NOT NULL,
  bucket        text,
  title         text NOT NULL,
  assignee_oids text[] NOT NULL DEFAULT '{}',
  start_date    date,
  due_date      date,
  percent_complete int NOT NULL DEFAULT 0,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS planner_tasks_plan ON planner_tasks (tenant_id, plan_id);

CREATE TABLE IF NOT EXISTS itsm_tickets (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  title         text NOT NULL,
  customer      text,
  assignee      text,
  status        text,
  opened_at     timestamptz,
  closed_at     timestamptz,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint   text NOT NULL,
  employee_id   uuid REFERENCES employees(id) ON DELETE CASCADE,
  mappings      jsonb NOT NULL,
  times_used    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  project_id    uuid REFERENCES projects(id),
  channel       text NOT NULL CHECK (channel IN ('page','chat','text')),
  file_name     text NOT NULL,
  blob_path     text,
  sha256        text,
  status        text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','review','confirmed','failed','discarded')),
  path_taken    text,                         -- template | ai | text-ai | manual
  model         text,
  prompt_version text,
  template_id   uuid REFERENCES templates(id),
  proposed_mappings jsonb,
  notes         jsonb NOT NULL DEFAULT '[]',
  error         text,
  week_start    date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- The same file by the same person is stopped, unless the earlier upload was discarded or failed.
CREATE UNIQUE INDEX IF NOT EXISTS uploads_dedupe ON uploads (employee_id, sha256)
  WHERE sha256 IS NOT NULL AND status IN ('processing','review','confirmed');

CREATE TABLE IF NOT EXISTS entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  project_id    uuid REFERENCES projects(id),
  upload_id     uuid REFERENCES uploads(id),
  work_date     date,
  start_time    time,
  end_time      time,
  hours         numeric(6,2),
  hours_rule    text,
  description   text NOT NULL DEFAULT '',
  link_kind     text CHECK (link_kind IN ('planner','itsm')),
  link_id       text,
  link_tenant   text,
  link_score    numeric(4,2),
  link_via      text,
  link_options  jsonb NOT NULL DEFAULT '[]',
  task_hint     text,
  ticket_hint   text,
  project_hint  text,
  flags         text[] NOT NULL DEFAULT '{}',
  confidence    numeric(3,2),
  source        text,
  source_text   text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','approved')),
  origin        text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','template','model','chat')),
  deleted       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  approved_by   uuid REFERENCES employees(id),
  approved_at   timestamptz
);
CREATE INDEX IF NOT EXISTS entries_emp_date ON entries (employee_id, work_date) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS entries_project ON entries (project_id, work_date) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS entries_upload ON entries (upload_id);

CREATE TABLE IF NOT EXISTS conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  title         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content       text,
  tool_calls    jsonb,
  card          jsonb,                          -- confirm / report card rendered by the UI
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, created_at);

-- The model can only propose a write. The person's click turns a pending action into a change.
CREATE TABLE IF NOT EXISTS pending_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('confirm_upload','edit_entry','delete_entry')),
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES employees(id),
  name          text NOT NULL,
  definition    jsonb NOT NULL,
  schedule      jsonb,                          -- {kind:'monthly'|'weekly', day, hour, recipients:[...]}
  last_run_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS periods (
  closed_before date NOT NULL,
  set_by        uuid REFERENCES employees(id),
  set_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid REFERENCES employees(id),
  action        text NOT NULL,
  target        text,
  detail        jsonb
);

CREATE TABLE IF NOT EXISTS job_runs (
  name          text PRIMARY KEY,
  last_run_at   timestamptz,
  last_status   text,
  last_detail   text
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name          text PRIMARY KEY,
  applied_at    timestamptz NOT NULL DEFAULT now()
);
