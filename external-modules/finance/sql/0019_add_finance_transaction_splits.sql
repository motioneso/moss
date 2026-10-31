-- Allocations are separate from the bank amount. Preserve them if a provider later
-- corrects that amount so the user can repair the split without losing their work.
ALTER TABLE app.finance_transactions
  ADD COLUMN splits jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(splits) = 'array'),
  ADD COLUMN split_revision integer NOT NULL DEFAULT 0 CHECK (split_revision >= 0)
