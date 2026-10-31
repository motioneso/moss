CREATE TABLE app.finance_card_policies (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  effective_month text NOT NULL CHECK (effective_month ~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, account_id),
  FOREIGN KEY (owner_user_id, account_id) REFERENCES app.finance_accounts(owner_user_id, account_id) ON DELETE CASCADE
);
