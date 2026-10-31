CREATE TABLE app.finance_provider_handoffs (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  transaction_id text NOT NULL,
  account_id text NOT NULL,
  snapshot jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id,item_id,transaction_id),
  FOREIGN KEY (owner_user_id,item_id) REFERENCES app.finance_items(owner_user_id,item_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id,account_id) REFERENCES app.finance_accounts(owner_user_id,account_id) ON DELETE CASCADE,
  CHECK ((jsonb_typeof(snapshot)='object' AND snapshot->>'id'=transaction_id
    AND snapshot->>'account_id'=account_id AND snapshot->'pending'='true'::jsonb
    AND snapshot->>'source'='provider') IS TRUE)
);
