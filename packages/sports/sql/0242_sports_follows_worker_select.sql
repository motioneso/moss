-- packages/sports/sql/0242_sports_follows_worker_select.sql
-- The morning briefing runs sports.followedFactsToday inside the briefings worker, which reads
-- app.sports_follows as jarvis_worker_runtime. 0133 granted only jarvis_app_runtime, so every
-- morning briefing selecting the sports tool hit "permission denied for table sports_follows".
--
-- Read-only and owner-scoped: FORCE RLS from 0133 stays authoritative and the worker sees only
-- the actor's own follows. The worker gets no write path.

DROP POLICY IF EXISTS sports_follows_worker_select ON app.sports_follows;
CREATE POLICY sports_follows_worker_select ON app.sports_follows
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT ON app.sports_follows TO jarvis_worker_runtime;
