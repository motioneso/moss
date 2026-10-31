-- Meals S4 (#3888): one shopping list per Kitchen. plan_id is the plan the list was built from;
-- deleting that plan leaves the list in place with no plan.
CREATE TABLE app.meals_shopping_lists (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  list_id uuid NOT NULL,
  plan_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, list_id),
  UNIQUE (owner_user_id, kitchen_id),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, plan_id)
    REFERENCES app.meals_plans (owner_user_id, plan_id) ON DELETE SET NULL (plan_id)
);
