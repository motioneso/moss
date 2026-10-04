-- #2981: owner-approved meeting deletion must remove its derived chat in the
-- same runtime transaction. General chat DELETE remains unavailable under RLS;
-- the separate security-definer incognito cleanup path is unchanged.
GRANT DELETE ON app.chat_threads TO jarvis_app_runtime;

CREATE POLICY chat_threads_meeting_delete
ON app.chat_threads
FOR DELETE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
  AND incognito = false
  -- Canonical base36 encoding of the complete unsigned 128-bit meeting UUID:
  -- no leading zero, at most 25 digits, and no value above 2^128 - 1.
  AND surface ~ '^mtg-(0|[1-9a-z][0-9a-z]{0,24})$'
  AND (
    length(surface) < 29
    OR substring(surface FROM 5) COLLATE "C" <= 'f5lxx1zz5pnorynqglhzmsp33' COLLATE "C"
  )
);
