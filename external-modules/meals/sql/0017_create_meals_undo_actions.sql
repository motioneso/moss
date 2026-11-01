-- Meals S4 (#3888): the one-step Undo record. before_state holds what the action changed, so Undo
-- can put it back; undone_at stops a second Undo.
CREATE TABLE app.meals_undo_actions (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  action_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bought', 'cooked', 'removed')),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  undone_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, action_id),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
