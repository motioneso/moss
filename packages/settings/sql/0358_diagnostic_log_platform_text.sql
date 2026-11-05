-- #3991 / #3978 slice 2E. Live admins can read cleaned platform warning text.
-- Other owners stay metadata-only; context and the admin gate are unchanged.
CREATE OR REPLACE FUNCTION app.read_diagnostic_log(
  p_since timestamptz, p_min_level smallint, p_component text,
  p_connection_kind text, p_limit integer)
RETURNS TABLE(
  occurred_at timestamptz, process text, level smallint, component text,
  connection_kind text, event_code text, owned boolean, owner_known boolean,
  message text, context jsonb, truncated boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT r.occurred_at, r.process, r.level, r.component, r.connection_kind, r.event_code,
         COALESCE(r.owner_user_id = app.current_actor_user_id(), false) AS owned,
         (r.owner_user_id IS NOT NULL) AS owner_known,
         CASE WHEN r.owner_user_id = app.current_actor_user_id() OR r.owner_user_id IS NULL THEN r.message END,
         CASE WHEN r.owner_user_id = app.current_actor_user_id() THEN r.context END,
         r.truncated
  FROM app.diagnostic_log_records r
  WHERE app.current_actor_is_admin()
    AND r.occurred_at >= p_since
    AND r.level >= p_min_level
    AND (p_component IS NULL OR r.component = p_component)
    AND (p_connection_kind IS NULL OR r.connection_kind = p_connection_kind)
  ORDER BY r.occurred_at DESC, r.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;
