CREATE TABLE app.finance_card_assignments (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  month text NOT NULL CHECK (month ~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$'),
  assigned_cents bigint NOT NULL CHECK (assigned_cents BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY (owner_user_id, account_id, month),
  FOREIGN KEY (owner_user_id, account_id) REFERENCES app.finance_card_policies(owner_user_id, account_id) ON DELETE CASCADE
);
