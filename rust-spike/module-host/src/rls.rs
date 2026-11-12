//! Host-generated policies. Guests declare the sharing model, never SQL policy bodies.
use crate::{
    database::runtime_role,
    manifest::{Manifest, TableAccess},
};
use anyhow::Result;
pub async fn emit(
    tx: &tokio_postgres::Transaction<'_>,
    manifest: &Manifest,
    table: &str,
) -> Result<()> {
    let role = runtime_role(&manifest.id);
    let owner = "owner_user_id=app.current_actor_user_id()";
    let (view, manage) = match manifest.database.access.get(table) {
        Some(TableAccess::OwnerOrShare {
            resource_type,
            share_key,
        }) => (
            format!("({owner} OR app.has_share('{resource_type}',{share_key},'view'))"),
            format!("({owner} OR app.has_share('{resource_type}',{share_key},'manage'))"),
        ),
        _ => (owner.into(), owner.into()),
    };
    tx.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY; DROP POLICY IF EXISTS moss_module_actor ON {table}; GRANT SELECT,INSERT,UPDATE,DELETE ON {table} TO {role}; GRANT EXECUTE ON FUNCTION app.has_share(text,uuid,text) TO {role}")).await?;
    for (name, command, using, check) in [
        ("select", "SELECT", Some(view.as_str()), None),
        ("insert", "INSERT", None, Some(owner)),
        (
            "update",
            "UPDATE",
            Some(manage.as_str()),
            Some(manage.as_str()),
        ),
        ("delete", "DELETE", Some(owner), None),
    ] {
        let using = using.map(|s| format!("USING ({s})")).unwrap_or_default();
        let check = check
            .map(|s| format!("WITH CHECK ({s})"))
            .unwrap_or_default();
        tx.batch_execute(&format!("DROP POLICY IF EXISTS moss_module_{name} ON {table}; CREATE POLICY moss_module_{name} ON {table} FOR {command} TO {role} {using} {check}")).await?;
    }
    Ok(())
}

/// Lets the owner delete rows of a legacy table. A share never grants delete.
pub async fn emit_owner_delete(tx: &tokio_postgres::Transaction<'_>, table: &str) -> Result<()> {
    tx.batch_execute(&format!(
        "SET LOCAL ROLE jarvis_migration_owner; \
         GRANT DELETE ON {table} TO jarvis_app_runtime, jarvis_worker_runtime; \
         DROP POLICY IF EXISTS moss_module_delete ON {table}; \
         CREATE POLICY moss_module_delete ON {table} FOR DELETE TO jarvis_app_runtime, jarvis_worker_runtime \
           USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id()); \
         RESET ROLE"
    ))
    .await?;
    Ok(())
}
