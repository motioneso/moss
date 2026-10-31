ALTER TABLE app.moss_action_audit_log
  DROP CONSTRAINT moss_action_audit_log_source_surface_check,
  ADD CONSTRAINT moss_action_audit_log_source_surface_check
    CHECK (source_surface IN ('chat', 'proactive', 'scheduled', 'module_page', 'unknown'));
