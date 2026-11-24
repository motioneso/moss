-- Host-owned configuration requests contain identifiers only, never module/account content.
CREATE TABLE moss_modules.install_requests (
    id uuid PRIMARY KEY,
    owner_account_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
    source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
    module text NOT NULL CHECK (length(module) BETWEEN 1 AND 100),
    operation_id uuid,
    approved_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((operation_id IS NULL) = (approved_by IS NULL)),
    UNIQUE (owner_account_id, source, module)
);
ALTER TABLE moss_modules.install_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE moss_modules.install_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON moss_modules.install_requests FROM PUBLIC;
CREATE POLICY install_requests_read ON moss_modules.install_requests
    FOR SELECT TO jarvis_app_runtime
    USING (owner_account_id = app.current_actor_user_id() OR app.current_actor_is_admin());
CREATE POLICY install_requests_create ON moss_modules.install_requests
    FOR INSERT TO jarvis_app_runtime
    WITH CHECK (owner_account_id = app.current_actor_user_id()
                AND operation_id IS NULL AND approved_by IS NULL);
CREATE POLICY install_requests_approve ON moss_modules.install_requests
    FOR UPDATE TO jarvis_app_runtime
    USING (app.current_actor_is_admin())
    WITH CHECK (app.current_actor_is_admin() AND approved_by = app.current_actor_user_id());
GRANT SELECT ON moss_modules.install_requests TO jarvis_app_runtime;
GRANT INSERT (id, owner_account_id, source, module) ON moss_modules.install_requests TO jarvis_app_runtime;
GRANT UPDATE (operation_id, approved_by) ON moss_modules.install_requests TO jarvis_app_runtime;
