-- #3174 (Finance R1): the activity trail. One row per finance write, with who
-- did it. params and undo hold ids, cents and category ids only; the row's
-- wording renders from kind + params in code, never from stored free text.
CREATE TABLE app.finance_activity (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  at timestamptz NOT NULL,
  actor text NOT NULL CHECK (actor IN ('user', 'moss')),
  kind text NOT NULL,
  params jsonb NOT NULL,
  undo jsonb,
  undone_at timestamptz,
  PRIMARY KEY (owner_user_id, id)
)
