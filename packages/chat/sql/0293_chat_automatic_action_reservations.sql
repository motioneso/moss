-- #3065 Slice 7: runtime code may only introduce known-tainted provenance.
-- Applied 0291 is intentionally unchanged, and no legacy rows are backfilled.
ALTER POLICY chat_conversation_provenance_insert ON app.chat_conversation_provenance
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND tainted_at IS NOT NULL
    AND first_admission_path IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );

-- FORCE RLS also applies to the migration-owner SECURITY DEFINER function. This
-- policy permits only clean initialization while inside the new-thread trigger,
-- and checks the actual parent rather than trusting the supplied owner column.
CREATE POLICY chat_conversation_provenance_initialize ON app.chat_conversation_provenance
  FOR INSERT TO jarvis_migration_owner
  WITH CHECK (
    pg_trigger_depth() = 1
    AND tainted_at IS NULL
    AND first_admission_path IS NULL
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id
        AND thread.owner_user_id = chat_conversation_provenance.owner_user_id
    )
  );

CREATE FUNCTION app.initialize_chat_conversation_provenance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  INSERT INTO app.chat_conversation_provenance (thread_id, owner_user_id)
  VALUES (NEW.id, NEW.owner_user_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.initialize_chat_conversation_provenance() FROM PUBLIC;

CREATE TRIGGER chat_threads_initialize_provenance
AFTER INSERT ON app.chat_threads
FOR EACH ROW EXECUTE FUNCTION app.initialize_chat_conversation_provenance();

-- A committed reservation survives process loss. There is deliberately no expiry,
-- content, cancellation, startup cleanup or mutable lease: only the callback that
-- acquired this opaque identity releases it after it actually settles.
CREATE TABLE app.chat_automatic_action_reservations (
  thread_id uuid PRIMARY KEY REFERENCES app.chat_threads (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL
);
ALTER TABLE app.chat_automatic_action_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_automatic_action_reservations FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_automatic_action_reservations_select ON app.chat_automatic_action_reservations
  FOR SELECT TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );
CREATE POLICY chat_automatic_action_reservations_insert ON app.chat_automatic_action_reservations
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );
CREATE POLICY chat_automatic_action_reservations_delete ON app.chat_automatic_action_reservations
  FOR DELETE TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );
GRANT SELECT, INSERT, DELETE ON app.chat_automatic_action_reservations TO jarvis_app_runtime;
