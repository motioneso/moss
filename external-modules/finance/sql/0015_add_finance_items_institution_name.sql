-- #3177: the bank's display name from Plaid, filled in on the next sync. Public
-- institution data only; never holds tokens or account numbers.
ALTER TABLE app.finance_items ADD COLUMN institution_name text
