-- Meals S7 (#3891): the two or three replacement recipes offered for one planned meal. A choice
-- is shown only once its recipe has passed Safety for the meal's eaters. Choose copies the
-- picked recipe onto the meal and deletes every choice for that meal.
CREATE TABLE app.meals_swap_choices (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  meal_id uuid NOT NULL,
  choice_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'writing', 'ready', 'failed')),
  recipe_id uuid NULL,
  generation integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, choice_id),
  FOREIGN KEY (owner_user_id, meal_id)
    REFERENCES app.meals_planned_meals (owner_user_id, meal_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id)
    REFERENCES app.meals_recipes (owner_user_id, recipe_id),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
