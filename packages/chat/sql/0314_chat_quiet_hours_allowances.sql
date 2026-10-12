-- #3145: explicit owner intent is separate from the reminder lifecycle and quiet schedule.
CREATE TABLE app.chat_reminder_quiet_allowances (
  reminder_id uuid PRIMARY KEY REFERENCES app.chat_reminders(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source_message_id uuid REFERENCES app.chat_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.chat_reminder_quiet_proposals (
  thread_id uuid PRIMARY KEY REFERENCES app.chat_threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL REFERENCES app.chat_reminders(id) ON DELETE CASCADE,
  reminder_version integer NOT NULL CHECK (reminder_version > 0),
  allow boolean NOT NULL,
  source_message_id uuid NOT NULL REFERENCES app.chat_messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.chat_reminder_quiet_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_reminder_quiet_allowances FORCE ROW LEVEL SECURITY;
ALTER TABLE app.chat_reminder_quiet_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_reminder_quiet_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY chat_reminder_quiet_allowances_read ON app.chat_reminder_quiet_allowances
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_reminder_quiet_allowances_delete ON app.chat_reminder_quiet_allowances
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_reminder_quiet_allowances_insert ON app.chat_reminder_quiet_allowances
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_reminders r
      JOIN app.chat_threads t ON t.id = r.thread_id
      JOIN app.chat_messages m ON m.thread_id = t.id
      WHERE r.id = reminder_id AND r.owner_user_id = app.current_actor_user_id()
        AND r.state IN ('queued', 'paused', 'delivered') AND r.context_state <> 'dismissed'
        AND t.is_main AND NOT t.incognito AND t.owner_user_id = app.current_actor_user_id()
        AND m.id = chat_reminder_quiet_allowances.source_message_id
        AND m.owner_user_id = app.current_actor_user_id() AND m.role = 'user'
    )
  );

CREATE POLICY chat_reminder_quiet_proposals_read ON app.chat_reminder_quiet_proposals
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_reminder_quiet_proposals_delete ON app.chat_reminder_quiet_proposals
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_reminder_quiet_proposals_insert ON app.chat_reminder_quiet_proposals
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_reminders r
      JOIN app.chat_threads t ON t.id = r.thread_id
      JOIN app.chat_messages m ON m.thread_id = t.id
      WHERE r.id = reminder_id AND r.owner_user_id = app.current_actor_user_id()
        AND t.id = chat_reminder_quiet_proposals.thread_id
        AND t.is_main AND NOT t.incognito AND t.owner_user_id = app.current_actor_user_id()
        AND m.id = chat_reminder_quiet_proposals.source_message_id
        AND m.owner_user_id = app.current_actor_user_id() AND m.role = 'user'
    )
  );

GRANT SELECT, INSERT, DELETE ON app.chat_reminder_quiet_allowances,
  app.chat_reminder_quiet_proposals TO jarvis_app_runtime;
GRANT SELECT ON app.chat_reminder_quiet_allowances,
  app.chat_reminder_quiet_proposals TO jarvis_worker_runtime;
