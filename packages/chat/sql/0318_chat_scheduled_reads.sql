-- #3151: an immutable exact read extends the existing owner-controlled responsibility.
CREATE TABLE app.chat_scheduled_reads (
  reminder_id uuid PRIMARY KEY REFERENCES app.chat_reminders(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation = 'tasks.get'),
  item_id uuid NOT NULL,
  outcome text CHECK (outcome IN ('success', 'refused', 'failed'))
);
ALTER TABLE app.chat_scheduled_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_scheduled_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_scheduled_reads_select ON app.chat_scheduled_reads
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_scheduled_reads_insert ON app.chat_scheduled_reads
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND outcome IS NULL AND EXISTS (
    SELECT 1 FROM app.chat_reminders r WHERE r.id = reminder_id
      AND r.owner_user_id = app.current_actor_user_id() AND r.state = 'queued'
  ));
CREATE POLICY chat_scheduled_reads_update ON app.chat_scheduled_reads
  FOR UPDATE TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT ON app.chat_scheduled_reads TO jarvis_app_runtime, jarvis_worker_runtime;
GRANT INSERT ON app.chat_scheduled_reads TO jarvis_app_runtime;
GRANT UPDATE(outcome) ON app.chat_scheduled_reads TO jarvis_worker_runtime;
