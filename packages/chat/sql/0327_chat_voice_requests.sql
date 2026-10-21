-- Durable voice admission precedes both pre-model actions and model dispatch.
CREATE UNIQUE INDEX chat_threads_id_owner_idx ON app.chat_threads (id, owner_user_id);

CREATE TABLE app.chat_voice_requests (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  source_device_id text NOT NULL CHECK (length(source_device_id) BETWEEN 1 AND 200),
  recording_id text NOT NULL CHECK (length(recording_id) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  transcript_revision integer NOT NULL CHECK (transcript_revision > 0),
  transcript text NOT NULL CHECK (length(transcript) <= 32768),
  captured_at timestamptz,
  automatic boolean NOT NULL,
  turn_id uuid NOT NULL UNIQUE,
  user_message_id uuid NOT NULL UNIQUE,
  assistant_message_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('no-speech', 'ready-to-send', 'queued', 'dispatching', 'replied', 'interrupted')),
  confirmed_at timestamptz,
  dispatch_boot_id uuid,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, source_device_id, recording_id),
  CONSTRAINT chat_voice_request_owner_thread FOREIGN KEY (thread_id, owner_user_id)
    REFERENCES app.chat_threads(id, owner_user_id) ON DELETE CASCADE,
  CHECK ((dispatch_boot_id IS NULL) = (dispatched_at IS NULL)),
  CHECK ((state IN ('dispatching', 'replied', 'interrupted')) = (dispatched_at IS NOT NULL)),
  CHECK ((state = 'no-speech') = (length(btrim(transcript)) = 0)),
  CHECK (turn_id <> user_message_id AND turn_id <> assistant_message_id AND user_message_id <> assistant_message_id)
);

CREATE INDEX chat_voice_requests_pending_idx ON app.chat_voice_requests (owner_user_id, created_at)
  WHERE state IN ('queued', 'dispatching');

ALTER TABLE app.chat_voice_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_voice_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_voice_requests_owner ON app.chat_voice_requests
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads t WHERE t.id = thread_id
        AND t.owner_user_id = app.current_actor_user_id() AND t.is_main AND NOT t.incognito
    )
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON app.chat_voice_requests TO jarvis_app_runtime;

-- Account archives run as the worker; expose only the owner-scoped export projection.
CREATE POLICY chat_voice_requests_export_worker ON app.chat_voice_requests
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (id, owner_user_id, thread_id, source_device_id, recording_id, fingerprint,
  transcript_revision, transcript, captured_at, automatic, turn_id, user_message_id,
  assistant_message_id, state, confirmed_at, dispatched_at, created_at, updated_at)
  ON app.chat_voice_requests TO jarvis_worker_runtime;

CREATE FUNCTION app.enforce_chat_voice_request_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state', 'confirmed_at', 'dispatch_boot_id', 'dispatched_at', 'updated_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state', 'confirmed_at', 'dispatch_boot_id', 'dispatched_at', 'updated_at']) THEN
    RAISE EXCEPTION 'voice request identity and transcript are immutable';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'ready-to-send' AND NEW.state = 'queued')
    OR (OLD.state = 'queued' AND NEW.state IN ('ready-to-send', 'dispatching'))
    OR (OLD.state = 'dispatching' AND NEW.state IN ('replied', 'interrupted'))
    OR (OLD.state = 'interrupted' AND NEW.state = 'replied')
  ) THEN RAISE EXCEPTION 'invalid voice request transition'; END IF;
  IF OLD.dispatched_at IS NOT NULL AND
    (NEW.dispatch_boot_id, NEW.dispatched_at) IS DISTINCT FROM (OLD.dispatch_boot_id, OLD.dispatched_at)
    THEN RAISE EXCEPTION 'voice dispatch cannot be reset'; END IF;
  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    THEN RAISE EXCEPTION 'voice confirmation cannot be reset'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_voice_requests_immutable BEFORE UPDATE ON app.chat_voice_requests
  FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_voice_request_identity();
