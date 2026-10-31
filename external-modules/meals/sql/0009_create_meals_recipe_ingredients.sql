-- Meals S2 (#3886): a recipe's ingredient lines in order. check_label carries the brand rule's
-- flag, which is added and never cleared.
CREATE TABLE app.meals_recipe_ingredients (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  position smallint NOT NULL,
  original_text text NOT NULL CHECK (char_length(original_text) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  name_key text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 80),
  quantity numeric(10,3) NULL CHECK (quantity > 0),
  unit text NULL CHECK (char_length(unit) BETWEEN 1 AND 24),
  store_section text NOT NULL CHECK (store_section IN (
    'produce', 'meat_fish', 'dairy_eggs', 'bakery', 'frozen', 'pantry', 'spices', 'drinks',
    'household', 'other'
  )),
  check_label boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, recipe_id, position),
  FOREIGN KEY (owner_user_id, recipe_id)
    REFERENCES app.meals_recipes (owner_user_id, recipe_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
