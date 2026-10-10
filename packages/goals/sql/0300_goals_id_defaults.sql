-- The repository inserts goals and evidence without an id, so the database generates it.
ALTER TABLE app.moss_goals ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE app.moss_goal_evidence ALTER COLUMN id SET DEFAULT gen_random_uuid();
