-- Meals S1 (#3885): at most one self member per Kitchen, so a repeated first read cannot add a
-- second "You".
CREATE UNIQUE INDEX meals_household_members_one_self
  ON app.meals_household_members (owner_user_id, kitchen_id) WHERE is_self;
