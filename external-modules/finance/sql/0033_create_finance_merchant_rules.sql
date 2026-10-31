CREATE TABLE app.finance_merchant_rules (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[0-9a-f]{32}$'),
  payee_key text NOT NULL CHECK (char_length(payee_key) BETWEEN 1 AND 200),
  category_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, id),
  UNIQUE (owner_user_id, payee_key),
  FOREIGN KEY (owner_user_id, category_id) REFERENCES app.finance_categories(owner_user_id, id)
);
