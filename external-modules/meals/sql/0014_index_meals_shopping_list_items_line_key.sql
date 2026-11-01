-- Meals S4 (#3888): one open line per merge key. A bought line steps out of the key so the same
-- item can be added again.
CREATE UNIQUE INDEX meals_shopping_list_items_line_key
  ON app.meals_shopping_list_items (owner_user_id, list_id, line_key)
  WHERE line_key IS NOT NULL AND bought_at IS NULL;
