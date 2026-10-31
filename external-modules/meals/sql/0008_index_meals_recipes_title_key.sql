-- Meals S2 (#3886): the no-repeat rule reads recent title keys per owner.
CREATE INDEX meals_recipes_title_key ON app.meals_recipes (owner_user_id, title_key);
