-- Meals S2 (#3886): one meal slot on a plan day. Each meal is saved as it finishes, so a retried
-- day resumes at the first meal that is not ready (spec correction C1).
CREATE TABLE app.meals_planned_meals (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  day_id uuid NOT NULL,
  meal_id uuid NOT NULL,
  slot_name text NOT NULL CHECK (char_length(slot_name) BETWEEN 1 AND 40),
  slot_position smallint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('recipe', 'text')),
  sharing text NOT NULL CHECK (sharing IN ('shared', 'solo')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'writing', 'ready', 'failed')),
  failure_reason text NULL CHECK (failure_reason IN (
    'needs_config', 'provider_error', 'usage_limited', 'validation_failed', 'aborted',
    'safety_cap', 'timeout', 'stopped'
  )),
  locked boolean NOT NULL DEFAULT false,
  one_off_for uuid NULL,
  favourite_of uuid NULL,
  servings_override numeric(3,1) NULL CHECK (
    servings_override BETWEEN 0.5 AND 24
    AND servings_override * 2 = floor(servings_override * 2)
  ),
  recipe_id uuid NULL,
  plain_text text NULL CHECK (char_length(plain_text) BETWEEN 1 AND 200),
  cooked_at timestamptz NULL,
  attempts smallint NOT NULL DEFAULT 0,
  generation integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, meal_id),
  FOREIGN KEY (owner_user_id, day_id)
    REFERENCES app.meals_plan_days (owner_user_id, day_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id)
    REFERENCES app.meals_recipes (owner_user_id, recipe_id),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, one_off_for)
    REFERENCES app.meals_household_members (owner_user_id, member_id)
    ON DELETE SET NULL (one_off_for),
  FOREIGN KEY (owner_user_id, favourite_of)
    REFERENCES app.meals_household_members (owner_user_id, member_id)
    ON DELETE SET NULL (favourite_of),
  CHECK (kind = 'recipe' OR plain_text IS NOT NULL)
);
