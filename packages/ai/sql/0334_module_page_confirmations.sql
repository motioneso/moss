ALTER TABLE app.ai_assistant_action_requests
  ADD COLUMN origin text CHECK (origin IS NULL OR origin = 'module_page'),
  ADD COLUMN input_digest bytea,
  ADD CONSTRAINT ai_assistant_action_page_confirmation_shape CHECK (
    (origin IS NULL AND input_digest IS NULL)
    OR (origin IS NOT NULL AND origin = 'module_page' AND input_digest IS NOT NULL
        AND octet_length(input_digest) = 32 AND expires_at IS NOT NULL
        AND chat_thread_id IS NULL AND chat_session_id IS NULL)
  );

CREATE FUNCTION app.enforce_module_page_confirmation_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.input_digest IS DISTINCT FROM OLD.input_digest THEN
    RAISE EXCEPTION 'Module page confirmation identity cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_assistant_action_page_identity_immutable
BEFORE UPDATE ON app.ai_assistant_action_requests
FOR EACH ROW EXECUTE FUNCTION app.enforce_module_page_confirmation_identity();
