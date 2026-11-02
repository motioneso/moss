ALTER TABLE app.meals_planned_meals ADD COLUMN quick_max_minutes smallint NULL CHECK (quick_max_minutes BETWEEN 5 AND 240);
