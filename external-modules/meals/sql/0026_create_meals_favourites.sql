-- Meals S10 (#3894): the recipes a person marked as a favourite. Favourites are per person.
CREATE TABLE app.meals_favourites (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  member_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, member_id, recipe_id),
  FOREIGN KEY (owner_user_id, member_id)
    REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id)
    REFERENCES app.meals_recipes (owner_user_id, recipe_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
