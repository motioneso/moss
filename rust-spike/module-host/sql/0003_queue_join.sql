CREATE TABLE moss_modules.paused_modules (module_id text PRIMARY KEY);
REVOKE ALL ON moss_modules.paused_modules FROM PUBLIC;
GRANT USAGE ON SCHEMA moss_modules TO jarvis_worker_runtime;
GRANT SELECT ON moss_modules.paused_modules TO jarvis_app_runtime, jarvis_worker_runtime;
-- Restrictive policies constrain even Phase 2b's all-metadata worker policy.
CREATE POLICY module_host_job_fence ON moss_queue.jobs AS RESTRICTIVE TO jarvis_worker_runtime
USING (NOT EXISTS (SELECT 1 FROM moss_modules.paused_modules WHERE module_id=payload->>'moduleId'))
WITH CHECK (NOT EXISTS (SELECT 1 FROM moss_modules.paused_modules WHERE module_id=payload->>'moduleId'));
CREATE POLICY module_host_schedule_fence ON moss_queue.schedules AS RESTRICTIVE TO jarvis_worker_runtime
USING (NOT EXISTS (SELECT 1 FROM moss_modules.paused_modules WHERE module_id=payload->>'moduleId'))
WITH CHECK (NOT EXISTS (SELECT 1 FROM moss_modules.paused_modules WHERE module_id=payload->>'moduleId'));
GRANT UPDATE(state,lease_token,lease_until) ON moss_queue.jobs TO jarvis_app_runtime;
CREATE TABLE moss_modules.account_choices(module_id text NOT NULL,actor_user_id uuid NOT NULL,enabled boolean NOT NULL,PRIMARY KEY(module_id,actor_user_id));
ALTER TABLE moss_modules.account_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE moss_modules.account_choices FORCE ROW LEVEL SECURITY;
CREATE POLICY account_choices_actor ON moss_modules.account_choices TO jarvis_app_runtime USING(actor_user_id=app.current_actor_user_id()) WITH CHECK(actor_user_id=app.current_actor_user_id());
CREATE POLICY account_choices_worker ON moss_modules.account_choices TO jarvis_worker_runtime USING(true);
GRANT SELECT,INSERT,UPDATE ON moss_modules.account_choices TO jarvis_app_runtime;
GRANT SELECT ON moss_modules.account_choices TO jarvis_worker_runtime;
CREATE TABLE moss_modules.account_defaults(module_id text PRIMARY KEY,enabled boolean NOT NULL);
REVOKE ALL ON moss_modules.account_defaults FROM PUBLIC;
GRANT SELECT ON moss_modules.account_defaults TO jarvis_worker_runtime;
CREATE POLICY module_host_account_jobs ON moss_queue.jobs AS RESTRICTIVE TO jarvis_worker_runtime
USING(COALESCE((SELECT c.enabled FROM moss_modules.account_choices c WHERE c.module_id=payload->>'moduleId' AND c.actor_user_id=jobs.actor_user_id),(SELECT d.enabled FROM moss_modules.account_defaults d WHERE d.module_id=payload->>'moduleId'),true))
WITH CHECK(COALESCE((SELECT c.enabled FROM moss_modules.account_choices c WHERE c.module_id=payload->>'moduleId' AND c.actor_user_id=jobs.actor_user_id),(SELECT d.enabled FROM moss_modules.account_defaults d WHERE d.module_id=payload->>'moduleId'),true));
CREATE POLICY module_host_account_schedules ON moss_queue.schedules AS RESTRICTIVE TO jarvis_worker_runtime
USING(COALESCE((SELECT c.enabled FROM moss_modules.account_choices c WHERE c.module_id=payload->>'moduleId' AND c.actor_user_id=schedules.actor_user_id),(SELECT d.enabled FROM moss_modules.account_defaults d WHERE d.module_id=payload->>'moduleId'),true))
WITH CHECK(COALESCE((SELECT c.enabled FROM moss_modules.account_choices c WHERE c.module_id=payload->>'moduleId' AND c.actor_user_id=schedules.actor_user_id),(SELECT d.enabled FROM moss_modules.account_defaults d WHERE d.module_id=payload->>'moduleId'),true));
