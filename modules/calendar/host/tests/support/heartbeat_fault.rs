//! Deliberately remove only the guest's owner predicates before real database execution.
use moss_module_host::{
    context::ContextPorts,
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    transactional_database::TransactionalDatabasePorts,
};
use moss_module_sdk::query::{Filter, Query};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct RemoveOwner {
    active: AtomicBool,
    next: Arc<dyn Ports>,
}
impl Ports for RemoveOwner {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        if self.active.load(Ordering::SeqCst) && port == "db" && request.operation == "query" {
            let mut query: Query = serde_json::from_value(request.parameters.clone())?;
            match &mut query.filter {
                Filter::Owned => query.filter = Filter::All,
                Filter::And { filters } => filters.retain(|f| !matches!(f, Filter::Owned)),
                _ => {}
            }
            let mut changed = request.clone();
            changed.parameters = serde_json::to_value(query)?;
            self.next.invoke(scope, port, &changed)
        } else {
            self.next.invoke(scope, port, request)
        }
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> anyhow::Result<()> {
        self.next.finish_call(scope, success)
    }
}
pub fn witness(f: &super::Fixture) {
    let ports = Arc::new(RemoveOwner {
        active: AtomicBool::new(true),
        next: Arc::new(
            TransactionalDatabasePorts::new(
                f.db.clone(),
                Arc::new(ContextPorts::new(Arc::new(DenyPorts))),
            )
            .unwrap(),
        ),
    });
    let host = Host::new(Limits::default()).unwrap();
    let component = moss_calendar_host::package::component(&f.core()).unwrap();
    let manifest = Arc::new(moss_calendar_host::package::manifest().unwrap());
    let assertion = || -> anyhow::Result<()> {
        let value: Value = serde_json::from_str(&host.call(
            &component,
            manifest.clone(),
            f.access(f.b),
            ports.clone(),
            "tool",
            &json!({"tool":"calendar.heartbeatWindow","parameters":{}}).to_string(),
        )?)?;
        anyhow::ensure!(
            value["data"]["items"] == json!([]) && value["data"]["freshness"] == "unknown",
            "heartbeat included a shared event or its sync timestamp"
        );
        Ok(())
    };
    let removed = assertion().expect_err("Owner-filter witness did not detect missing predicates");
    assert_eq!(
        removed.to_string(),
        "heartbeat included a shared event or its sync timestamp"
    );
    println!("RED heartbeat: same assertion rejected shared event/sync visibility with owner predicates removed before real SQL execution");
    ports.active.store(false, Ordering::SeqCst);
    assertion().unwrap();
    println!("GREEN heartbeat: same assertion passed with original guest predicates restored");
}
