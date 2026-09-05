-- Spec 2026-09-04-email-chief-of-staff: the second pass reads a whole thread by owner and
-- provider thread id (external_metadata->>'threadId'), oldest message first.
CREATE INDEX IF NOT EXISTS idx_email_messages_owner_thread
  ON app.email_messages (owner_user_id, (external_metadata->>'threadId'), received_at);
