CREATE TABLE app.finance_bill_adjustments (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL,
  due_date date NOT NULL CHECK (due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  planned_date date NOT NULL CHECK (planned_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, plan_id, due_date),
  FOREIGN KEY (owner_user_id, plan_id) REFERENCES app.finance_bill_plans(owner_user_id, id)
);
