-- Meals S6 (#3890): serves the Log screen's main read, one owner's entries on one local date.
CREATE INDEX meals_log_entries_owner_local_date_idx
  ON app.meals_log_entries (owner_user_id, local_date, consumed_at);
