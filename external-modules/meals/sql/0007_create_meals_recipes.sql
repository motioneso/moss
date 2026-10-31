-- Meals S2 (#3886): a written recipe. title_key is the normalised title the no-repeat rule
-- compares against.
CREATE TABLE app.meals_recipes (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  title_key text NOT NULL CHECK (char_length(title_key) BETWEEN 1 AND 120),
  steps jsonb NOT NULL
    CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 30),
  cook_minutes smallint NOT NULL CHECK (cook_minutes BETWEEN 1 AND 600),
  base_servings numeric(3,1) NOT NULL CHECK (base_servings BETWEEN 0.5 AND 24),
  kcal_per_serving integer NULL CHECK (kcal_per_serving BETWEEN 0 AND 5000),
  source text NOT NULL CHECK (source IN ('generated', 'favourite', 'imported')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, recipe_id),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
