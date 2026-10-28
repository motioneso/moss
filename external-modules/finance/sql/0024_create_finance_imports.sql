CREATE TABLE app.finance_imports (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id text NOT NULL,
  account_id text NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count BETWEEN 1 AND 200),
  operation_digest text NOT NULL CHECK (length(operation_digest) = 64),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, id)
);
