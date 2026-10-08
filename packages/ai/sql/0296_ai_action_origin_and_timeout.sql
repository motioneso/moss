ALTER TYPE app.ai_assistant_action_status ADD VALUE IF NOT EXISTS 'timed_out';

-- Old requests have no provable origin. Leave them unbound rather than adopting
-- whichever conversation happens to be open after a restart.
ALTER TABLE app.ai_assistant_action_requests
  ADD COLUMN IF NOT EXISTS chat_thread_id uuid,
  ADD COLUMN IF NOT EXISTS chat_session_id text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE OR REPLACE FUNCTION app.enforce_ai_assistant_action_origin_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chat_thread_id IS DISTINCT FROM OLD.chat_thread_id
     OR NEW.chat_session_id IS DISTINCT FROM OLD.chat_session_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'AI assistant action origin cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_assistant_action_origin_immutable
BEFORE UPDATE ON app.ai_assistant_action_requests
FOR EACH ROW EXECUTE FUNCTION app.enforce_ai_assistant_action_origin_immutable();

CREATE INDEX ai_assistant_action_requests_pending_expiry_idx
ON app.ai_assistant_action_requests(expires_at, id) WHERE status = 'pending';

-- The legacy boot cleanup must not cancel deadline-bound requests held by a peer.
CREATE OR REPLACE FUNCTION app.cancel_stale_ai_assistant_action_requests(older_than timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, public
AS $$
DECLARE affected integer;
BEGIN
  UPDATE app.ai_assistant_action_requests
  SET status = 'cancelled', resolved_at = now(), updated_at = now()
  WHERE status = 'pending' AND expires_at IS NULL AND requested_at < older_than;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
