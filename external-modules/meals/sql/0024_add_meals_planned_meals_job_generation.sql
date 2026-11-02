-- Meals S7 (#3891): a counter for meal-level jobs (swap choices, Safety re-check). Each request
-- raises it, so every request gets a new queue key.
ALTER TABLE app.meals_planned_meals
  ADD COLUMN job_generation integer NOT NULL DEFAULT 0;
