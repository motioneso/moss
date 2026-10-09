-- #3172 (Finance R1): budget categories as an owner-only table, replacing the
-- finance.categories KV taxonomy. group_name is one of Bills, Everyday, Fun,
-- Savings, Income. Categories are archived (archived_at), never deleted, so
-- stored transactions and assignments keep resolving their category id.
CREATE TABLE app.finance_categories (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id text NOT NULL,
  group_name text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL,
  is_income boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  PRIMARY KEY (owner_user_id, id)
)
