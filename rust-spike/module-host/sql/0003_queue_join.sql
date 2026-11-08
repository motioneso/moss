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
