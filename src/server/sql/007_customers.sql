-- Customers added by hand (ITSM customers come from the synced tickets); one row per name, case-insensitive.
CREATE TABLE IF NOT EXISTS customers (
  name        text PRIMARY KEY,
  created_by  uuid REFERENCES employees(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_lower_name ON customers (lower(name));
