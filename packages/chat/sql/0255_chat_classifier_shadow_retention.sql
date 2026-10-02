-- Classifier gate shadow records: keep forever, delete on request (#2908, Ben ruling 16,
-- 2026-10-02). Supersedes the fixed 7-day purge in 0251.
--
-- The purge function and its worker job are removed. The app role gains DELETE, scoped to the
-- caller's own rows by row-level security — no admin, thread-sharing or recipient branch. Account
-- deletion still removes the rows through owner_user_id's ON DELETE CASCADE. 0251 is applied and
-- must never be edited, so this migration only alters grants/policies.

-- The SECURITY DEFINER purge function was the sole consumer of these maintenance policies.
DROP POLICY IF EXISTS chat_classifier_shadow_records_maintenance_select
  ON app.chat_classifier_shadow_records;
DROP POLICY IF EXISTS chat_classifier_shadow_records_maintenance_delete
  ON app.chat_classifier_shadow_records;

DROP FUNCTION IF EXISTS app.purge_expired_chat_classifier_shadow_records();

GRANT DELETE ON app.chat_classifier_shadow_records TO jarvis_app_runtime;

-- Owner-only delete. The USING clause is the only filter: an admin actor's id never equals the
-- owner's, so an admin deletes only their own records and no one else's.
DROP POLICY IF EXISTS chat_classifier_shadow_records_delete
  ON app.chat_classifier_shadow_records;
CREATE POLICY chat_classifier_shadow_records_delete
ON app.chat_classifier_shadow_records
FOR DELETE TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
