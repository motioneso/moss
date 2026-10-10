-- #3174 (Finance R1): serves the newest-first activity list.
CREATE INDEX finance_activity_owner_at ON app.finance_activity (owner_user_id, at DESC)
