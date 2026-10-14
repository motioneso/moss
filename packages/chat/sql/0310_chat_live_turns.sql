-- #3128: one row per live chat reply in flight, written before the model sees the question.
-- A completed turn deletes its row in the same transaction that stores the turn. A row left
-- by an earlier API boot marks a reply that a restart interrupted; the next read of that chat
-- stores the question and an interrupted note in its place, and never resubmits it.
CREATE TABLE app.chat_live_turns (
  turn_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES app.chat_threads (id) ON DELETE CASCADE,
  boot_id uuid NOT NULL,
  user_text text NOT NULL CHECK (length(btrim(user_text)) > 0),
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_live_turns_thread_idx ON app.chat_live_turns (thread_id, boot_id);

ALTER TABLE app.chat_live_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_live_turns FORCE ROW LEVEL SECURITY;

-- Owner-only. Thread sharing never exposes another user's in-flight question, and a private
-- chat never records one.
CREATE POLICY chat_live_turns_select ON app.chat_live_turns
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_live_turns_insert ON app.chat_live_turns
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id
        AND thread.owner_user_id = app.current_actor_user_id()
        AND NOT thread.incognito
    )
  );
CREATE POLICY chat_live_turns_delete ON app.chat_live_turns
  FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, DELETE ON app.chat_live_turns TO jarvis_app_runtime;
