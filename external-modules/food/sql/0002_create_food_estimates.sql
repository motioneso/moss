-- Food Phase 1 (#926, #1701): food_estimates — one row per estimator revision
-- for a meal. Every nutrient column is nullable by design: unknown, pending,
-- or failed estimates are NULL, never 0.
CREATE TABLE app.food_estimates (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  meal_id uuid NOT NULL,
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
  estimator_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, meal_id, revision),
  FOREIGN KEY (owner_user_id, meal_id)
    REFERENCES app.food_meals (owner_user_id, meal_id) ON DELETE CASCADE
);
