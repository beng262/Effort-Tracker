-- What the standard daily form carries beyond hours: category, customer, project/SLA/opportunity name, product, outcome, progress.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS customer text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS work_item text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS product text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS progress text;
CREATE INDEX IF NOT EXISTS entries_category ON entries (category) WHERE NOT deleted;
