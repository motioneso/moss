-- Classifier gate (#2984 R2.4): the shadow review that unlocks the gate's `on` state.
--
-- One row per classifier selection records that an admin reviewed the shadow report for that
-- classifier. The gate reads `on` as `shadow` unless a row matches the classifier currently
-- selected, so changing the classifier or deleting the row drops the gate back to shadow at once.
-- EMPTY BY DEFAULT: the review step (plan task 4.2) is the only writer.
--
-- Instance-global admin data, not private user data: RLS mirrors app.instance_settings (all authed
-- actors may read, only admins may write). No admin private-data bypass is introduced.

CREATE TABLE IF NOT EXISTS app.chat_classifier_shadow_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  classifier_model_id text NOT NULL CHECK (length(btrim(classifier_model_id)) > 0),
  classifier_provider_model_id text NOT NULL
    CHECK (length(btrim(classifier_provider_model_id)) > 0),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  CONSTRAINT chat_classifier_shadow_reviews_unique
    UNIQUE (classifier_model_id, classifier_provider_model_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.chat_classifier_shadow_reviews TO jarvis_app_runtime;
GRANT SELECT ON app.chat_classifier_shadow_reviews TO jarvis_worker_runtime;

ALTER TABLE app.chat_classifier_shadow_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_classifier_shadow_reviews FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_classifier_shadow_reviews_select ON app.chat_classifier_shadow_reviews;
CREATE POLICY chat_classifier_shadow_reviews_select
ON app.chat_classifier_shadow_reviews
FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
USING (true);

DROP POLICY IF EXISTS chat_classifier_shadow_reviews_insert ON app.chat_classifier_shadow_reviews;
CREATE POLICY chat_classifier_shadow_reviews_insert
ON app.chat_classifier_shadow_reviews
FOR INSERT TO jarvis_app_runtime
WITH CHECK (app.current_actor_is_admin());

DROP POLICY IF EXISTS chat_classifier_shadow_reviews_update ON app.chat_classifier_shadow_reviews;
CREATE POLICY chat_classifier_shadow_reviews_update
ON app.chat_classifier_shadow_reviews
FOR UPDATE TO jarvis_app_runtime
USING (app.current_actor_is_admin())
WITH CHECK (app.current_actor_is_admin());

DROP POLICY IF EXISTS chat_classifier_shadow_reviews_delete ON app.chat_classifier_shadow_reviews;
CREATE POLICY chat_classifier_shadow_reviews_delete
ON app.chat_classifier_shadow_reviews
FOR DELETE TO jarvis_app_runtime
USING (app.current_actor_is_admin());
