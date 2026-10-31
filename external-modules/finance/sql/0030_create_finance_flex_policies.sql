CREATE TABLE app.finance_flex_policies (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  active boolean NOT NULL,
  flex_ids jsonb NOT NULL CHECK (jsonb_typeof(flex_ids) = 'array'),
  non_monthly_ids jsonb NOT NULL CHECK (jsonb_typeof(non_monthly_ids) = 'array'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, month)
);
