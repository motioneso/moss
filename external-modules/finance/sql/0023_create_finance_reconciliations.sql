CREATE TABLE app.finance_reconciliations (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id text NOT NULL,
  account_id text NOT NULL,
  statement_date date NOT NULL,
  balance_cents bigint NOT NULL CHECK (balance_cents BETWEEN -9007199254740991 AND 9007199254740991),
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 0 AND 500),
  operation_digest text NOT NULL CHECK (length(operation_digest) = 64),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, id)
);
