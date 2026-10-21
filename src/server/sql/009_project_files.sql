-- Files that belong to a project. The bytes are in the blob store (projects/<project>/<file>/<name>); this is the list.
CREATE TABLE IF NOT EXISTS project_files (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL,
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,
  blob_path    text NOT NULL,
  note         text,
  uploaded_by  uuid NOT NULL REFERENCES employees(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  deleted      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS project_files_project ON project_files (project_id, uploaded_at DESC) WHERE NOT deleted;
CREATE UNIQUE INDEX IF NOT EXISTS project_files_same_content ON project_files (project_id, sha256) WHERE NOT deleted;
