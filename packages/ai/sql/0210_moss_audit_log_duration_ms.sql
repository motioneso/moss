-- #2175 Task 7: record how long a tool call took, so slow calls are visible in Activity.
ALTER TABLE app.moss_action_audit_log
  ADD COLUMN duration_ms integer;
