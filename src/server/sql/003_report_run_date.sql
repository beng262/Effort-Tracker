-- The logical day a scheduled report last ran, so "once per day" does not depend on the database clock.
ALTER TABLE report_definitions ADD COLUMN IF NOT EXISTS last_run_date date;
