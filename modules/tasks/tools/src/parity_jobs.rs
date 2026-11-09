//! Disposable differential adapter only. The real Rust queue and compiled guest
//! execute the work; spike_jobs is solely the old harness's result observation table.
use super::Server;
use access_context::AccessContext;
use anyhow::{ensure, Context, Result};
use moss_module_host::{
    context::ContextPorts,
    jobs::{manifest_hash, module_key, specs},
    runtime::{DenyPorts, Ports},
    transactional_database::TransactionalDatabasePorts,
};
use moss_platform_jobs::{ClaimedJob, Queue, Role};
use safety_core::db::Database;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::watch;

pub async fn prepare() -> Result<()> {
    let (db, connection) = tokio_postgres::connect(
        &std::env::var("MOSS_BOOTSTRAP_DATABASE_URL")?,
        tokio_postgres::NoTls,
    )
    .await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    db.batch_execute(moss_platform_jobs::MIGRATION).await?;
    // This table already belongs to the disposable harness, never the package.
    // Workers record observed output only after finishing the actual queue job.
    db.batch_execute("GRANT INSERT ON spike_jobs.jobs TO jarvis_worker_runtime")
        .await?;
    Ok(())
}

fn execute(state: &Server, ports: Arc<dyn Ports>, job: &ClaimedJob) -> Result<Value> {
    let envelope = serde_json::to_value(&job.metadata)?;
    ensure!(
        envelope["manifestHash"] == manifest_hash(&state.manifest),
        "Module version changed"
    );
    let prefix = format!("{}.", module_key(&state.manifest.id));
    let queue = job
        .metadata
        .job_kind()
        .strip_prefix(&prefix)
        .context("Unknown Tasks queue")?;
    let parameters = job.metadata.params().cloned().unwrap_or_else(|| json!({}));
    // Queue::claim already checked these parameters against specs(manifest).
    let output = state.host.call(
        &state.wasm,
        state.manifest.clone(),
        AccessContext::new(job.actor.user_id(), job.actor.request_id().to_string()),
        ports,
        "job",
        &json!({"queue":queue,"parameters":parameters}).to_string(),
    )?;
    Ok(serde_json::from_str(&output)?)
}

pub async fn run(state: Server, worker: Database, mut stop: watch::Receiver<bool>) -> Result<()> {
    let url = std::env::var("MOSS_WORKER_DATABASE_URL")?;
    let queue = Queue::connect(&url, Role::Worker, specs(&state.manifest)).await?;
    let (observer, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let ports: Arc<dyn Ports> = tokio::task::spawn_blocking(move || -> Result<_> {
        Ok(Arc::new(ContextPorts::new(Arc::new(
            TransactionalDatabasePorts::new(worker, Arc::new(DenyPorts))?,
        ))) as Arc<dyn Ports>)
    })
    .await??;
    let outcome = async {
        while !*stop.borrow() {
            if let Some(job) = queue.claim().await? {
                let state = state.clone();
                let ports = ports.clone();
                let (job, result) = tokio::task::spawn_blocking(move || {
                    let result = execute(&state, ports, &job);
                    (job, result)
                }).await?;
                queue.finish(&job, result.is_ok()).await?;
                // Read the queue's actual terminal state; retries are not failures.
                let terminal = observer.query_one(
                    "SELECT state FROM moss_queue.jobs WHERE id=$1", &[&job.id],
                ).await?.get::<_, String>(0);
                if matches!(terminal.as_str(), "completed" | "failed") {
                    let output = result.unwrap_or_else(|_| json!({"message":"Tasks job failed"}));
                    let metadata = serde_json::to_value(&job.metadata)?;
                    observer.execute(
                        "INSERT INTO spike_jobs.jobs(id,queue,data,state,output,completed_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())",
                        &[&job.id, &job.metadata.job_kind(), &metadata, &terminal, &output],
                    ).await?;
                }
                eprintln!("Tasks differential worker observed {terminal} real-queue job");
                continue;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = stop.changed() => {},
            }
        }
        Ok(())
    }.await;
    // Ports own synchronous runtimes; their last drop must be off the async executor.
    tokio::task::spawn_blocking(move || drop((state, ports))).await?;
    outcome
}
