-- #2175: widen audit outcome so a tool's self-reported "suppressed" (served without reaching the
-- underlying service, e.g. duplicate-call suppression) or "refused" (blocked by a request budget)
-- outcome can be recorded distinctly from the existing "success"/"failed"/"denied" values.
ALTER TABLE app.moss_action_audit_log
  DROP CONSTRAINT moss_action_audit_log_outcome_check;
ALTER TABLE app.moss_action_audit_log
  ADD CONSTRAINT moss_action_audit_log_outcome_check
  CHECK (outcome IN ('success', 'failed', 'denied', 'cancelled', 'invalid', 'conflict',
                      'suppressed', 'refused'));
