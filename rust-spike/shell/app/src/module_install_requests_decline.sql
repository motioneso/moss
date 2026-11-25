-- Separate upgrade: existing request migrations are immutable.
BEGIN;
ALTER TABLE moss_modules.install_requests
    ADD COLUMN declined_by uuid,
    ADD COLUMN declined_at timestamptz,
    ADD CONSTRAINT install_requests_decline_pair CHECK ((declined_by IS NULL) = (declined_at IS NULL)),
    ADD CONSTRAINT install_requests_decline_unapproved CHECK (declined_by IS NULL OR operation_id IS NULL);
DROP POLICY install_requests_approve ON moss_modules.install_requests;
CREATE POLICY install_requests_decide ON moss_modules.install_requests
    FOR UPDATE TO jarvis_app_runtime
    USING (app.current_actor_is_admin())
    WITH CHECK (app.current_actor_is_admin() AND
        ((declined_by = app.current_actor_user_id() AND approved_by IS NULL AND operation_id IS NULL)
         OR (approved_by = app.current_actor_user_id() AND declined_by IS NULL AND declined_at IS NULL)));
GRANT UPDATE (declined_by, declined_at) ON moss_modules.install_requests TO jarvis_app_runtime;
COMMIT;
