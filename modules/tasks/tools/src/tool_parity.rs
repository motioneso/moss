//! Line-oriented compiled tool adapter for differential tests only, never an app endpoint.
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    context::ContextPorts,
    runtime::{DenyPorts, Host, Limits},
    transactional_database::TransactionalDatabasePorts,
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    sync::Arc,
};

fn main() -> Result<()> {
    ensure!(
        std::env::var("JARVIS_GATE_RUN").as_deref() == Ok("1"),
        "Use scripts/run-gate.sh"
    );
    let runtime = tokio::runtime::Runtime::new()?;
    let database = runtime
        .block_on(Database::connect(
            &std::env::var("JS51_APP_URL")?,
            4,
            RuntimeRole::App,
        ))
        .map_err(anyhow::Error::msg)?;
    let ports = Arc::new(ContextPorts::new(Arc::new(
        TransactionalDatabasePorts::new(database, Arc::new(DenyPorts))?,
    )));
    let manifest = Arc::new(moss_tasks_checks::manifest()?);
    let wasm = std::fs::read(std::env::var("TASKS_COMPONENT")?)?;
    let host = Host::new(Limits::default())?;
    host.validate(&wasm, &manifest)?;
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let actor = command["actor"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing test actor"))?
            .parse()?;
        let output = host.call(
            &wasm,
            manifest.clone(),
            AccessContext::new(actor, "tool-differential"),
            ports.clone(),
            "tool",
            &command["request"].to_string(),
        );
        let output = match output {
            Ok(value) => json!({"ok":serde_json::from_str::<Value>(&value)?}),
            Err(_) => json!({"error":true}),
        };
        println!("{output}");
        io::stdout().flush()?;
    }
    Ok(())
}
