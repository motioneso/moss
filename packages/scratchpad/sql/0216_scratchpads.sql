-- #2236 slice 1: a single owner-only scratchpad row per user for quick jot-down text.
CREATE TABLE app.scratchpads (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  sync_to_notes boolean NOT NULL DEFAULT false,
  shortcut text NOT NULL DEFAULT 'mod+shift+s',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scratchpads_body_size CHECK (length(body) <= 64000)
);

ALTER TABLE app.scratchpads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scratchpads FORCE ROW LEVEL SECURITY;

CREATE POLICY scratchpads_select_owner ON app.scratchpads
  FOR SELECT USING (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_insert_owner ON app.scratchpads
  FOR INSERT WITH CHECK (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_update_owner ON app.scratchpads
  FOR UPDATE USING (user_id = app.current_actor_user_id()) WITH CHECK (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_delete_owner ON app.scratchpads
  FOR DELETE USING (user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.scratchpads TO jarvis_app_runtime;
