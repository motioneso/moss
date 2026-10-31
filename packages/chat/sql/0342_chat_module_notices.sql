-- Chat owns admission receipts; source content remains in ordinary stored messages.
CREATE TABLE app.chat_module_notices (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  module_id text NOT NULL CHECK (module_id ~ '^[a-z][a-z0-9_-]{0,79}$'),
  source_id uuid NOT NULL,
  source_version text NOT NULL CHECK (octet_length(source_version) BETWEEN 1 AND 160),
  notice_kind text NOT NULL CHECK (notice_kind ~ '^[a-z][a-z0-9_-]{0,79}$'),
  thread_id uuid NOT NULL REFERENCES app.chat_threads(id) ON DELETE CASCADE,
  -- Receipt precedes worker message INSERT so its policy can validate the reservation.
  message_id uuid NOT NULL UNIQUE REFERENCES app.chat_messages(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  actions jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, module_id, source_id, source_version, notice_kind)
);
ALTER TABLE app.chat_module_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_module_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_module_notices_owner_select ON app.chat_module_notices
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_module_notices_owner_insert ON app.chat_module_notices
  FOR INSERT TO jarvis_app_runtime, jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND EXISTS (
    SELECT 1 FROM app.chat_threads t WHERE t.id = thread_id
      AND t.owner_user_id = app.current_actor_user_id()
      AND t.surface = 'drawer' AND t.is_main AND NOT t.incognito
  ));
GRANT SELECT, INSERT ON app.chat_module_notices TO jarvis_app_runtime, jarvis_worker_runtime;

-- A worker may insert only the assistant message reserved by its own admitted Main notice.
CREATE POLICY chat_messages_insert_module_notice ON app.chat_messages
  FOR INSERT TO jarvis_worker_runtime WITH CHECK (
    owner_user_id = app.current_actor_user_id() AND role = 'assistant' AND status = 'stored'
    AND EXISTS (
      SELECT 1 FROM app.chat_module_notices n JOIN app.chat_threads t ON t.id = n.thread_id
      WHERE n.message_id = chat_messages.id AND n.thread_id = chat_messages.thread_id
        AND n.owner_user_id = app.current_actor_user_id()
        AND t.owner_user_id = app.current_actor_user_id()
        AND t.is_main AND t.surface = 'drawer' AND NOT t.incognito
        AND chat_messages.model_metadata->'origin'->>'kind' = 'module_notice'
        AND chat_messages.model_metadata->'origin'->>'version' = '1'
        AND chat_messages.model_metadata->'origin'->>'noticeId' = n.id::text
        AND chat_messages.model_metadata->'origin'->>'moduleId' = n.module_id
        AND chat_messages.model_metadata->'origin'->>'sourceId' = n.source_id::text
        AND chat_messages.model_metadata->'origin'->>'sourceVersion' = n.source_version
        AND chat_messages.model_metadata->'origin'->>'noticeKind' = n.notice_kind
        AND chat_messages.model_metadata->'origin'->'actions' = n.actions
    )
  );

-- Delivery intent exists before Main or a worker is available; contains metadata only.
CREATE TABLE app.chat_module_notice_intents (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  module_id text NOT NULL CHECK (module_id ~ '^[a-z][a-z0-9_-]{0,79}$'),
  source_id uuid NOT NULL,
  source_version text NOT NULL CHECK (octet_length(source_version) BETWEEN 1 AND 160),
  notice_kind text NOT NULL CHECK (notice_kind ~ '^[a-z][a-z0-9_-]{0,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id,module_id,source_id,source_version,notice_kind)
);
ALTER TABLE app.chat_module_notice_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_module_notice_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_module_notice_intents_owner_select ON app.chat_module_notice_intents
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id());
CREATE POLICY chat_module_notice_intents_owner_insert ON app.chat_module_notice_intents
  FOR INSERT TO jarvis_app_runtime, jarvis_worker_runtime WITH CHECK (owner_user_id=app.current_actor_user_id());
CREATE POLICY chat_module_notice_intents_owner_delete ON app.chat_module_notice_intents
  FOR DELETE TO jarvis_app_runtime, jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id());
GRANT SELECT, INSERT, DELETE ON app.chat_module_notice_intents TO jarvis_app_runtime, jarvis_worker_runtime;
