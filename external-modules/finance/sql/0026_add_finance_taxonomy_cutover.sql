-- The owner policy records the atomic transition from the legacy KV taxonomy.
ALTER TABLE app.finance_budget_policy ADD COLUMN taxonomy_ready boolean NOT NULL DEFAULT false
