-- Meals S4 (#3888): one shopping line. line_key is the merge identity (normalised name plus unit
-- family) for lines built from the plan and NULL for manual lines. quantity and unit are what the
-- recipes need; purchase_* is the rounded amount to buy. A rebuild updates lines in place, so a
-- tick (checked_at) survives it.
CREATE TABLE app.meals_shopping_list_items (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  list_id uuid NOT NULL,
  line_id uuid NOT NULL,
  line_key text NULL CHECK (char_length(line_key) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  quantity numeric(10,3) NULL CHECK (quantity > 0),
  unit text NULL CHECK (char_length(unit) BETWEEN 1 AND 24),
  purchase_quantity numeric(10,3) NULL CHECK (purchase_quantity > 0),
  purchase_unit text NULL CHECK (char_length(purchase_unit) BETWEEN 1 AND 24),
  store_section text NOT NULL CHECK (store_section IN (
    'produce', 'meat_fish', 'dairy_eggs', 'bakery', 'frozen', 'pantry', 'spices', 'drinks',
    'household', 'other'
  )),
  manual boolean NOT NULL DEFAULT false,
  covered_by_pantry boolean NOT NULL DEFAULT false,
  not_in_plan boolean NOT NULL DEFAULT false,
  converted_from jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(converted_from) = 'array'),
  source_meal_ids uuid[] NOT NULL DEFAULT '{}',
  checked_at timestamptz NULL,
  bought_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, line_id),
  FOREIGN KEY (owner_user_id, list_id)
    REFERENCES app.meals_shopping_lists (owner_user_id, list_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE,
  CHECK (manual OR line_key IS NOT NULL)
);
