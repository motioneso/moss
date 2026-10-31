-- Meals S1 (#3885): Shared or Solo per meal of the day. solo_weekdays holds ISO weekdays
-- (1 = Monday, 7 = Sunday) on one row per slot.
CREATE TABLE app.meals_meal_slot_rules (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  slot_name text NOT NULL CHECK (char_length(slot_name) BETWEEN 1 AND 40),
  solo_weekdays smallint[] NOT NULL DEFAULT '{}',
  usual_time time NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, kitchen_id, slot_name),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
