-- Meals S5 (#3889): foods the Kitchen always has. A Staple counts as on hand, so it never reaches
-- the shopping list and never makes a "cook only from on hand" recipe fail.
CREATE TABLE app.meals_staples (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  staple_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  name_key text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, staple_id),
  UNIQUE (owner_user_id, kitchen_id, name_key),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
