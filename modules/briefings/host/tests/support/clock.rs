//! The installed test's clock wraps the real host ports; queue and database time stay real.
use access_context::AccessContext;
use moss_module_host::{
    after_commit_jobs::AfterCommitJobs,
    application::{Application, Configuration},
    context::ContextPorts,
    database::DatabasePorts,
    jobs::JobPorts,
    local::LocalPorts,
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    runtime::{CallScope, Host, Limits, Ports, Request},
    services::ServicePorts,
    sql::LegacyInventory,
    store::Installer,
    transactional_database::TransactionalDatabasePorts,
};
use safety_core::db::Database;
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

pub type Clock = Arc<Mutex<String>>;

struct ClockPorts {
    next: Arc<dyn Ports>,
    now: Clock,
}
impl Ports for ClockPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        // Delegate first to preserve authorization, identity and validation.
        let mut value = self.next.invoke(scope, port, request)?;
        if port == "context" && request.operation == "read" && request.resource == "call" {
            value["now"] = Value::String(self.now.lock().unwrap().clone());
        }
        Ok(value)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.next.finish_call(scope, success)
    }
}

/// Mirrors open_extended's adapters, with a clock outside ContextPorts so its live time is replaced.
/// Only the installed test uses this assembly; production keeps its ordinary clock.
pub fn application(
    data: &Path,
    database: Database,
    admin: AccessContext,
    config: Configuration,
    now: Clock,
) -> anyhow::Result<Application> {
    let local = Arc::new(LocalPorts::new(data)?);
    let sql = Arc::new(DatabasePorts::new(database.clone(), local)?);
    let jobs = Arc::new(JobPorts::new(config.producer, database.clone(), sql)?);
    let services = Arc::new(ServicePorts::new(
        data,
        config.cipher,
        config.intelligence,
        jobs,
    )?);
    let deferred = Arc::new(AfterCommitJobs::new(services.clone()));
    let context = Arc::new(ContextPorts::new(deferred));
    let clock = Arc::new(ClockPorts { next: context, now });
    let ports = Arc::new(TransactionalDatabasePorts::new(database.clone(), clock)?);
    let lifecycle = Arc::new(PostgresLifecycle::new(
        config.migrations,
        database.clone(),
        data,
    )?);
    let catalog = Arc::new(PostgresCatalog::new(database, admin)?);
    let limits = Limits {
        fuel_ceiling: config.fuel_ceiling.unwrap_or(Limits::default().fuel),
        ..Limits::default()
    };
    let installer = Arc::new(Installer::new(
        data,
        catalog,
        lifecycle,
        Host::new(limits)?,
        ports,
        config.version,
        LegacyInventory::default(),
    )?);
    services.bind(&installer);
    Ok(Application {
        installer,
        services,
    })
}
