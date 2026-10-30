CREATE TABLE app.finance_bill_plans (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  account_id text NOT NULL,
  category_id text NOT NULL,
  iso_currency text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  anchor_date date NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('once', 'weekly', 'fortnightly', 'monthly', 'yearly')),
  end_date date,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, id),
  FOREIGN KEY (owner_user_id, account_id) REFERENCES app.finance_accounts(owner_user_id, account_id),
  FOREIGN KEY (owner_user_id, category_id) REFERENCES app.finance_categories(owner_user_id, id)
);
