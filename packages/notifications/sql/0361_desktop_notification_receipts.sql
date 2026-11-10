-- Desktop acceptance is separate from reading the notification in Moss.
CREATE TABLE app.desktop_notification_receipts (
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  notification_id uuid NOT NULL REFERENCES app.notifications(id) ON DELETE CASCADE,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id, notification_id)
);
CREATE INDEX desktop_receipts_notification_id_idx
  ON app.desktop_notification_receipts(notification_id);
ALTER TABLE app.desktop_notification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.desktop_notification_receipts FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON app.desktop_notification_receipts TO jarvis_app_runtime;
CREATE POLICY desktop_receipts_recipient ON app.desktop_notification_receipts
  TO jarvis_app_runtime
  USING (
    user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.notifications n
      WHERE n.id = notification_id AND n.recipient_user_id = app.current_actor_user_id()
    )
  )
  WITH CHECK (
    user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.notifications n
      WHERE n.id = notification_id AND n.recipient_user_id = app.current_actor_user_id()
    )
  );
