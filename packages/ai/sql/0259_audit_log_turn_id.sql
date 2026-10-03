-- #2956 slice A: link tool-audit rows to their chat turn. The audit log already carries
-- request_id and chat_session_id but no turn id; the Activity page joins a chat answer's
-- steps to its turn on this column (spec section 5.3). Nullable: only chat turns set it.

ALTER TABLE app.moss_action_audit_log
  ADD COLUMN turn_id text
    CHECK (turn_id IS NULL OR (length(btrim(turn_id)) > 0 AND length(turn_id) <= 128));

CREATE INDEX IF NOT EXISTS moss_action_audit_log_turn_idx
  ON app.moss_action_audit_log (turn_id) WHERE turn_id IS NOT NULL;
