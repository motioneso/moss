-- Meals S4 (#3888): Pantry lookups by ingredient name.
CREATE INDEX meals_pantry_items_name_key
  ON app.meals_pantry_items (owner_user_id, kitchen_id, name_key);
