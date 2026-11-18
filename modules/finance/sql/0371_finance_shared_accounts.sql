CREATE TABLE app.finance_shared_accounts (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  subtype text,
  mask text,
  balance_cents bigint NOT NULL,
  iso_currency text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (owner_user_id, account_id)
);
