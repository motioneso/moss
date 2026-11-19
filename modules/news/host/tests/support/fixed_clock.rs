//! A fixed clock around the real context port, keeping installed route dispatch intact.
use moss_module_host::{
    after_commit_jobs::AfterCommitJobs,
    application::Application,
    context::ContextPorts,
    migrations::PostgresLifecycle,
    postgres::PostgresCatalog,
    runtime::{CallScope, Host, Limits, Ports, Request},
    sql::LegacyInventory,
    store::Installer,
    transactional_database::TransactionalDatabasePorts,
};
use safety_core::secret::Secret;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

struct FixedClock(Arc<dyn Ports>, &'static str);
impl Ports for FixedClock {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        // Let the real host authorize and answer first; only replace the call's time.
        let mut answer = self.0.invoke(scope, port, request)?;
        if port == "context" && request.operation == "read" && request.resource == "call" {
            answer["now"] = json!(self.1);
        }
        Ok(answer)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.0.finish_call(scope, success)
    }
}

/// Application's web adapter is inside ContextPorts. Reopen the same installed catalog with
/// the clock outside ContextPorts, preserving the transaction and deferred-job adapters.
pub fn reopen(app: &mut Application, f: &super::support::Fixture, data: &Path, now: &'static str) {
    let deferred = Arc::new(AfterCommitJobs::new(Arc::new(super::Web(
        app.services.clone(),
    ))));
    let context = Arc::new(ContextPorts::new(deferred));
    let clock = Arc::new(FixedClock(context, now));
    let ports = Arc::new(TransactionalDatabasePorts::new(f.db.clone(), clock).unwrap());
    let lifecycle = Arc::new(
        PostgresLifecycle::new(
            Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            f.db.clone(),
            data,
        )
        .unwrap(),
    );
    let catalog = Arc::new(PostgresCatalog::new(f.db.clone(), f.access(f.a)).unwrap());
    let host = Host::new(Limits {
        fuel_ceiling: 250_000_000,
        ..Limits::default()
    })
    .unwrap();
    let installer = Arc::new(
        Installer::new(
            data,
            catalog,
            lifecycle,
            host,
            ports,
            "0.1.0".parse().unwrap(),
            LegacyInventory::default(),
        )
        .unwrap(),
    );
    app.services.bind(&installer);
    app.installer = installer;
}
