-- A project's own plan: tasks with owners, dependencies, target dates and status, imported from Excel
-- or edited with the assistant. People can link their effort to these tasks just like Planner tasks.

CREATE TABLE IF NOT EXISTS project_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ext_id        text NOT NULL,                  -- the id used in the plan itself, e.g. W1.4
  section       text,                           -- phase / wave heading the task sits under
  title         text NOT NULL,
  owner_name    text,
  owner_id      uuid REFERENCES employees(id) ON DELETE SET NULL,
  depends_on    text,
  due_date      date,
  status        text NOT NULL DEFAULT 'Planlandı' CHECK (status IN ('Planlandı','Devam','Tamamlandı','Bloke')),
  position      int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, ext_id)
);
CREATE INDEX IF NOT EXISTS project_tasks_project ON project_tasks (project_id, position);

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_link_kind_check;
ALTER TABLE entries ADD CONSTRAINT entries_link_kind_check CHECK (link_kind IN ('planner','itsm','project'));

ALTER TABLE pending_actions DROP CONSTRAINT IF EXISTS pending_actions_kind_check;
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_kind_check
  CHECK (kind IN ('confirm_upload','edit_entry','delete_entry','plan_import','plan_update'));
