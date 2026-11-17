CREATE TABLE app.finance_shared_transactions (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id text NOT NULL,
  account_id text NOT NULL,
  date date NOT NULL,
  amount_cents bigint NOT NULL,
  iso_currency text NOT NULL,
  name text NOT NULL,
  merchant text,
  plaid_category text,
  category_id text,
  pending boolean NOT NULL,
  pending_transaction_id text,
  categorized_by text,
  transfer_id uuid,
  splits jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(splits) = 'array'),
  PRIMARY KEY (owner_user_id, id)
);
