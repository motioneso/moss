-- A read may need confirmation (for example, model-selected input sent outside).
-- Keep its effective risk truthful; read calls still do not enter the write audit log.
ALTER TABLE app.ai_assistant_action_requests
  DROP CONSTRAINT IF EXISTS ai_assistant_action_requests_risk_check,
  ADD CONSTRAINT ai_assistant_action_requests_risk_check
    CHECK (risk IN ('read', 'write', 'outbound', 'destructive'));
