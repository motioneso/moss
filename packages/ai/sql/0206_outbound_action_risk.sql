ALTER TABLE app.ai_assistant_action_requests
  DROP CONSTRAINT IF EXISTS ai_assistant_action_requests_risk_check,
  ADD CONSTRAINT ai_assistant_action_requests_risk_check
    CHECK (risk IN ('write', 'outbound', 'destructive'));

ALTER TABLE app.moss_action_audit_log
  DROP CONSTRAINT IF EXISTS moss_action_audit_log_action_kind_check,
  ADD CONSTRAINT moss_action_audit_log_action_kind_check
    CHECK (action_kind IN ('write', 'outbound', 'destructive'));
