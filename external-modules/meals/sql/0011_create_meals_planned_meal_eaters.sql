-- Meals S2 (#3886): who eats a planned meal, their portion and calorie fit, and their Safety
-- verdict. A model judgement can add a failure here but never clear the rule's.
CREATE TABLE app.meals_planned_meal_eaters (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  meal_id uuid NOT NULL,
  member_id uuid NOT NULL,
  portion numeric(3,1) NOT NULL DEFAULT 1 CHECK (portion BETWEEN 0.5 AND 4),
  estimated_kcal integer NULL CHECK (estimated_kcal BETWEEN 0 AND 10000),
  safety text NOT NULL DEFAULT 'pending' CHECK (safety IN ('pending', 'pass', 'fail')),
  safety_reason text NULL CHECK (char_length(safety_reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, meal_id, member_id),
  FOREIGN KEY (owner_user_id, meal_id)
    REFERENCES app.meals_planned_meals (owner_user_id, meal_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, member_id)
    REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
