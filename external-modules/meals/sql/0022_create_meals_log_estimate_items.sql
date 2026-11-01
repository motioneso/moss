-- Meals S6 (#3890): one row per food inside an entry, for one estimate revision. The seven
-- nutrient columns on meals_log_estimates are the sum of these rows and are never written from a
-- model value directly. A correction writes a new revision with a new item set.
CREATE TABLE app.meals_log_estimate_items (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  revision integer NOT NULL,
  item_index integer NOT NULL,
  label text NOT NULL,
  portion_note text,
  calories_kcal numeric(8,2),
  protein_g numeric(8,2),
  carbohydrates_g numeric(8,2),
  fat_g numeric(8,2),
  fiber_g numeric(8,2),
  sugar_g numeric(8,2),
  sodium_mg numeric(9,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, entry_id, revision, item_index),
  FOREIGN KEY (owner_user_id, entry_id, revision)
    REFERENCES app.meals_log_estimates (owner_user_id, entry_id, revision) ON DELETE CASCADE,
  CHECK (item_index >= 0),
  CHECK (char_length(label) BETWEEN 1 AND 200),
  CHECK (portion_note IS NULL OR char_length(portion_note) BETWEEN 1 AND 100)
);
