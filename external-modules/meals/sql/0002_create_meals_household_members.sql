-- Meals S1 (#3885): the people a Kitchen cooks for. The self member carries the owner's own
-- targets (spec correction C3); linked_account_email is stored as typed and resolved in phase 5
-- (spec correction C6).
CREATE TABLE app.meals_household_members (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  member_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  is_self boolean NOT NULL DEFAULT false,
  linked_account_email text NULL CHECK (char_length(linked_account_email) BETWEEN 3 AND 320),
  calorie_target integer NULL CHECK (calorie_target BETWEEN 800 AND 6000),
  protein_target_g integer NULL CHECK (protein_target_g BETWEEN 0 AND 600),
  carb_target_g integer NULL CHECK (carb_target_g BETWEEN 0 AND 1000),
  fat_target_g integer NULL CHECK (fat_target_g BETWEEN 0 AND 400),
  meal_pattern jsonb NOT NULL DEFAULT '["breakfast","lunch","dinner"]'
    CHECK (jsonb_typeof(meal_pattern) = 'array' AND jsonb_array_length(meal_pattern) BETWEEN 1 AND 6),
  restrictions jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(restrictions) = 'array' AND jsonb_array_length(restrictions) <= 40),
  preferences jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(preferences) = 'array' AND jsonb_array_length(preferences) <= 40),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, member_id),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
