-- Food Phase 2 (#926, #1737): food_estimate_items — one row per individual food
-- inside a meal, for one estimator revision. A meal is a container of items; the
-- seven nutrient columns on food_estimates are the SUM of these rows and are never
-- written from a model value directly.
--
-- Every nutrient column is nullable for the same reason as food_estimates: unknown
-- is NULL, never 0. A meal whose items include a NULL for a nutrient is incomplete
-- for that nutrient, exactly as a day containing an unestimated meal is.
--
-- Keyed on the estimate revision, not just the meal, so a correction writes a new
-- revision with a new item set and the previous breakdown stays readable.
CREATE TABLE app.food_estimate_items (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  meal_id uuid NOT NULL,
  revision integer NOT NULL,
  item_index integer NOT NULL,
  label text NOT NULL,
  -- The quantity as described ("6", "32 oz", "1 cup cooked"), kept apart from the
  -- food name so a later database lookup has something to resolve against. Nothing
  -- in this phase parses it.
  portion_note text,
  calories_kcal numeric(8,2),
  protein_g numeric(8,2),
  carbohydrates_g numeric(8,2),
  fat_g numeric(8,2),
  fiber_g numeric(8,2),
  sugar_g numeric(8,2),
  sodium_mg numeric(9,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, meal_id, revision, item_index),
  FOREIGN KEY (owner_user_id, meal_id, revision)
    REFERENCES app.food_estimates (owner_user_id, meal_id, revision) ON DELETE CASCADE,
  CHECK (item_index >= 0),
  CHECK (char_length(label) BETWEEN 1 AND 200),
  CHECK (portion_note IS NULL OR char_length(portion_note) BETWEEN 1 AND 100)
);
