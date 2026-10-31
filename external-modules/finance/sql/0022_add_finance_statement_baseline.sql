ALTER TABLE app.finance_accounts
  ADD COLUMN last_reconciled_date date,
  ADD COLUMN last_reconciled_balance_cents bigint,
  ADD CONSTRAINT finance_accounts_statement_baseline CHECK (
    (last_reconciled_date IS NULL AND last_reconciled_balance_cents IS NULL) OR
    (source = 'manual' AND last_reconciled_date IS NOT NULL AND last_reconciled_balance_cents IS NOT NULL
      AND last_reconciled_date >= opening_date
      AND last_reconciled_balance_cents BETWEEN -9007199254740991 AND 9007199254740991)
  );
