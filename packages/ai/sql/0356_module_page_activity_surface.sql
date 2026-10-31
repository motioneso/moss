-- #3723: page writes from a module's own page record activity with their own source, so the
-- activity screen never labels a click on a module page as something Moss did in chat.
ALTER TABLE app.moss_action_audit_log
  DROP CONSTRAINT moss_action_audit_log_source_surface_check,
  ADD CONSTRAINT moss_action_audit_log_source_surface_check
    CHECK (source_surface IN ('chat', 'proactive', 'scheduled', 'unknown', 'module_page'));
