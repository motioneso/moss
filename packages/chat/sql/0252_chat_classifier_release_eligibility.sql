-- Classifier gate, task 1.2 (#2881): approved tool release eligibility.
--
-- The gate is one instance-wide switch (off/shadow/on). Turning it `on` is only allowed when at
-- least one row here matches an approved review. This table is EMPTY BY DEFAULT: the review step
-- (plan task 4.2) is the only writer, and it records the reviewed tool plus the classifier/config
-- version the approval was granted for, so a later classifier change does not inherit an old
-- approval.
--
-- Instance-global admin data, not private user data: RLS mirrors app.instance_settings (all authed
-- actors may read, only admins may write). No admin private-data bypass is introduced.

CREATE TABLE IF NOT EXISTS app.chat_classifier_release_eligibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id text NOT NULL CHECK (length(btrim(module_id)) > 0),
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) > 0),
  classifier_config_version text NOT NULL CHECK (length(btrim(classifier_config_version)) > 0),
  approved_at timestamptz NOT NULL DEFAULT now(),
  approved_by_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  CONSTRAINT chat_classifier_release_eligibility_unique
    UNIQUE (module_id, tool_name, classifier_config_version)
);

CREATE INDEX IF NOT EXISTS chat_classifier_release_eligibility_approved_idx
  ON app.chat_classifier_release_eligibility (approved_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.chat_classifier_release_eligibility
  TO jarvis_app_runtime;
GRANT SELECT ON app.chat_classifier_release_eligibility TO jarvis_worker_runtime;

ALTER TABLE app.chat_classifier_release_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_classifier_release_eligibility FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_classifier_release_eligibility_select
  ON app.chat_classifier_release_eligibility;
CREATE POLICY chat_classifier_release_eligibility_select
ON app.chat_classifier_release_eligibility
FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
USING (true);

DROP POLICY IF EXISTS chat_classifier_release_eligibility_insert
  ON app.chat_classifier_release_eligibility;
CREATE POLICY chat_classifier_release_eligibility_insert
ON app.chat_classifier_release_eligibility
FOR INSERT TO jarvis_app_runtime
WITH CHECK (app.current_actor_is_admin());

DROP POLICY IF EXISTS chat_classifier_release_eligibility_update
  ON app.chat_classifier_release_eligibility;
CREATE POLICY chat_classifier_release_eligibility_update
ON app.chat_classifier_release_eligibility
FOR UPDATE TO jarvis_app_runtime
USING (app.current_actor_is_admin())
WITH CHECK (app.current_actor_is_admin());

DROP POLICY IF EXISTS chat_classifier_release_eligibility_delete
  ON app.chat_classifier_release_eligibility;
CREATE POLICY chat_classifier_release_eligibility_delete
ON app.chat_classifier_release_eligibility
FOR DELETE TO jarvis_app_runtime
USING (app.current_actor_is_admin());
