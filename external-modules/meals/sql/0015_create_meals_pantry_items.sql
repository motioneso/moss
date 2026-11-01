-- Meals S4 (#3888): what the Kitchen has at home. Bought writes rows here; the Pantry screen and
-- subtraction arrive in S5. A NULL quantity means "have some".
CREATE TABLE app.meals_pantry_items (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  item_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  name_key text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 80),
  quantity numeric(10,3) NULL CHECK (quantity >= 0),
  unit text NULL CHECK (char_length(unit) BETWEEN 1 AND 24),
  source text NOT NULL CHECK (source IN ('manual', 'bought', 'leftover', 'receipt')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, item_id),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
