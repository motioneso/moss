-- #2981: a thread's server-selected context is permanent. Retargeting an
-- existing thread would bypass meeting-scoped history and deletion boundaries.
-- Keep the existing identity, owner/update-scope and incognito guards intact.
CREATE FUNCTION app.prevent_chat_thread_surface_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.surface IS DISTINCT FROM OLD.surface THEN
    RAISE EXCEPTION 'chat thread surface cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_threads_prevent_surface_change
BEFORE UPDATE ON app.chat_threads
FOR EACH ROW
EXECUTE FUNCTION app.prevent_chat_thread_surface_change();

REVOKE ALL ON FUNCTION app.prevent_chat_thread_surface_change() FROM PUBLIC;

-- Durable chat rows remain undeletable by direct runtime SQL. A bounded definer
-- entry point mirrors private-session cleanup while retaining forced owner RLS.
REVOKE DELETE ON app.chat_threads FROM jarvis_app_runtime;
DROP POLICY chat_threads_meeting_delete ON app.chat_threads;

CREATE POLICY chat_threads_meeting_cleanup_delete
ON app.chat_threads
FOR DELETE
TO jarvis_migration_owner
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
  AND incognito = false
  AND surface ~ '^mtg-(0|[1-9a-z][0-9a-z]{0,24})$'
  AND (
    length(surface) < 29
    OR substring(surface FROM 5) COLLATE "C" <= 'f5lxx1zz5pnorynqglhzmsp33' COLLATE "C"
  )
);

CREATE FUNCTION app.delete_meeting_chat_threads_for_cleanup(p_surface text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  DELETE FROM app.chat_threads
  WHERE surface = p_surface
    AND app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
    AND incognito = false
    AND surface ~ '^mtg-(0|[1-9a-z][0-9a-z]{0,24})$'
    AND (
      length(surface) < 29
      OR substring(surface FROM 5) COLLATE "C" <= 'f5lxx1zz5pnorynqglhzmsp33' COLLATE "C"
    )
$$;

REVOKE ALL ON FUNCTION app.delete_meeting_chat_threads_for_cleanup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_meeting_chat_threads_for_cleanup(text)
  TO jarvis_app_runtime;
