CREATE TABLE app.finance_bill_suggestion_dismissals (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  payee_key text NOT NULL CHECK (char_length(payee_key) BETWEEN 1 AND 160),
  cadence text NOT NULL CHECK (cadence IN ('weekly', 'fortnightly', 'monthly', 'yearly')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  dismissed_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, account_id, payee_key, cadence, amount_cents),
  FOREIGN KEY (owner_user_id, account_id) REFERENCES app.finance_accounts(owner_user_id, account_id) ON DELETE CASCADE
);
