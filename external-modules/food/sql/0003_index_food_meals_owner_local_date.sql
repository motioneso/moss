-- Food Phase 1 (#926, #1701): serves the page's primary read — one owner's
-- meals on one local date, ordered by consumed_at.
CREATE INDEX food_meals_owner_local_date_idx ON app.food_meals (owner_user_id, local_date, consumed_at);
