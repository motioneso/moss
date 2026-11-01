-- Meals S10 (#3894): one star rating per person per recipe. One star is a near-veto: the recipe
-- stays out of plans that include that person unless a request names it.
CREATE TABLE app.meals_ratings (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  member_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  rated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, member_id, recipe_id),
  FOREIGN KEY (owner_user_id, member_id)
    REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id)
    REFERENCES app.meals_recipes (owner_user_id, recipe_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
