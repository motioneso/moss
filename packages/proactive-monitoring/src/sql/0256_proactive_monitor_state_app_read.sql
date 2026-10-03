-- Migration 0256: let the app runtime read proactive monitor state.
-- The manual refresh route reads last_checked_at for its cooldown check and runs as
-- jarvis_app_runtime, which 0122 never granted. SELECT only; the worker keeps all writes.
-- The owner-only FORCE RLS policy still applies.

GRANT SELECT ON app.proactive_monitor_state TO jarvis_app_runtime;
