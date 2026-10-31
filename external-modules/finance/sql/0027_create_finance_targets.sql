CREATE TABLE app.finance_targets (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  category_id text NOT NULL,
  effective_month text NOT NULL CHECK (effective_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind text NOT NULL CHECK (kind IN ('monthly', 'balance', 'removed')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 9007199254740991),
  due_date date,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, category_id, effective_month),
  FOREIGN KEY (owner_user_id, category_id) REFERENCES app.finance_categories(owner_user_id, id),
  CHECK ((kind = 'removed' AND amount_cents = 0 AND due_date IS NULL) OR (kind = 'monthly' AND amount_cents > 0 AND due_date IS NULL) OR (kind = 'balance' AND amount_cents > 0 AND due_date IS NOT NULL))
);
