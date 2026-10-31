-- Manual records keep provider identifiers and snapshots unchanged.
ALTER TABLE app.finance_accounts
  ALTER COLUMN item_id DROP NOT NULL,
  ADD COLUMN source text NOT NULL DEFAULT 'provider',
  ADD COLUMN opening_date date,
  ADD COLUMN opening_balance_cents bigint,
  ADD COLUMN creation_digest text,
  ADD COLUMN ledger_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT finance_accounts_source CHECK (source IN ('provider', 'manual')),
  ADD CONSTRAINT finance_accounts_manual_baseline CHECK (
    source <> 'manual' OR (item_id IS NULL AND opening_date IS NOT NULL
      AND opening_balance_cents IS NOT NULL AND creation_digest IS NOT NULL
      AND length(creation_digest) = 64
      AND opening_balance_cents BETWEEN -9007199254740991 AND 9007199254740991
      AND balance_cents BETWEEN -9007199254740991 AND 9007199254740991)
  );
