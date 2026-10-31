CREATE TABLE app.finance_budget_policy (
  owner_user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  iso_currency text NOT NULL CHECK (iso_currency IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'CNY', 'HKD', 'SGD', 'INR', 'MXN')),
  created_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
