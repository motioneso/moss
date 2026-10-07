-- #3065 Slice 6: no backfill. Only newly created threads receive a clean row;
-- unknown history is treated as tainted by the conversation provenance port.
CREATE TABLE app.chat_conversation_provenance (
  thread_id uuid PRIMARY KEY REFERENCES app.chat_threads (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  tainted_at timestamptz,
  first_admission_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((tainted_at IS NULL) = (first_admission_path IS NULL))
);

ALTER TABLE app.chat_conversation_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_conversation_provenance FORCE ROW LEVEL SECURITY;

-- Thread sharing never grants access to safety state. Checking the actual parent
-- owner also prevents inserting an actor-owned row for somebody else's thread.
CREATE POLICY chat_conversation_provenance_select ON app.chat_conversation_provenance
  FOR SELECT TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );
CREATE POLICY chat_conversation_provenance_insert ON app.chat_conversation_provenance
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );
CREATE POLICY chat_conversation_provenance_update ON app.chat_conversation_provenance
  FOR UPDATE TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  )
  WITH CHECK (
    owner_user_id = app.current_actor_user_id() AND tainted_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );

-- The first admission and its identity are immutable. A second admission may
-- retain the same values, but cannot replace the reason or move taint elsewhere.
CREATE FUNCTION app.prevent_chat_provenance_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.thread_id IS DISTINCT FROM OLD.thread_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'chat conversation provenance identity cannot be changed';
  END IF;
  IF OLD.tainted_at IS NOT NULL AND (
    NEW.tainted_at IS DISTINCT FROM OLD.tainted_at
    OR NEW.first_admission_path IS DISTINCT FROM OLD.first_admission_path
  ) THEN
    RAISE EXCEPTION 'chat conversation first admission cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_conversation_provenance_prevent_rewrite
BEFORE UPDATE ON app.chat_conversation_provenance
FOR EACH ROW EXECUTE FUNCTION app.prevent_chat_provenance_rewrite();

-- No direct DELETE: deleting then reinserting clean would erase known taint.
-- The thread/user foreign keys still cascade when the parent is legitimately purged.
GRANT SELECT, INSERT, UPDATE ON app.chat_conversation_provenance TO jarvis_app_runtime;
