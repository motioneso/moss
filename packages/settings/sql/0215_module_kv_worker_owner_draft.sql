-- #2267: the verified worker invoker admits owner drafts, but 0157's KV policies
-- admit only enabled modules. Add the narrow user-storage path needed by drafts.
-- Existing enabled-module and instance-storage policies remain authoritative.
CREATE POLICY module_kv_worker_owner_draft ON app.module_kv
  FOR ALL TO jarvis_worker_runtime
  USING (
    scope = 'user'
    AND owner_user_id = app.current_actor_user_id()
    AND module_id = app.current_module_id()
    AND app.current_actor_is_admin()
    AND EXISTS (
      SELECT 1 FROM app.external_modules module
      WHERE module.id = module_kv.module_id
        AND module.status = 'draft'
        AND module.owner_user_id = app.current_actor_user_id()
    )
  );
-- FOR ALL uses the USING expression as WITH CHECK too, so inserts and updates
-- cannot change the owner, module, scope or draft authority to escape the policy.
