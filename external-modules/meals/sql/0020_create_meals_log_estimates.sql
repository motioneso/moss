-- Meals S6 (#3890): one row per estimate revision of a log entry. Every nutrient column is
-- nullable. Unknown, pending and failed are NULL, never 0.
CREATE TABLE app.meals_log_estimates (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  revision integer NOT NULL,
  calories_kcal numeric(8,2),
  protein_g numeric(8,2),
  carbohydrates_g numeric(8,2),
  fat_g numeric(8,2),
  fiber_g numeric(8,2),
  sugar_g numeric(8,2),
  sodium_mg numeric(9,2),
  missing_details text,
  clarification_question text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, entry_id, revision),
  FOREIGN KEY (owner_user_id, entry_id)
    REFERENCES app.meals_log_entries (owner_user_id, entry_id) ON DELETE CASCADE
);
