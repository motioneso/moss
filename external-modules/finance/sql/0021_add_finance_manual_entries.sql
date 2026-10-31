ALTER TABLE app.finance_transactions
  ADD COLUMN source text NOT NULL DEFAULT 'provider',
  ADD COLUMN entry_digest text,
  ADD COLUMN cleared boolean NOT NULL DEFAULT false,
  ADD COLUMN reconciled_at timestamptz,
  ADD CONSTRAINT finance_transactions_source CHECK (source IN ('provider', 'manual')),
  ADD CONSTRAINT finance_transactions_manual_entry CHECK (
    source <> 'manual' OR (pending = false AND entry_digest IS NOT NULL
      AND length(entry_digest) = 64 AND amount_cents <> 0
      AND amount_cents BETWEEN -9007199254740991 AND 9007199254740991)
  );
