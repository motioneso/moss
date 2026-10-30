CREATE TABLE app.finance_bill_occurrences (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL,
  due_date date NOT NULL,
  state text NOT NULL CHECK (state IN ('skipped', 'matched')),
  transaction_id text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, plan_id, due_date),
  UNIQUE (owner_user_id, transaction_id),
  FOREIGN KEY (owner_user_id, plan_id) REFERENCES app.finance_bill_plans(owner_user_id, id),
  CHECK ((state = 'skipped' AND transaction_id IS NULL) OR (state = 'matched' AND transaction_id IS NOT NULL))
);
