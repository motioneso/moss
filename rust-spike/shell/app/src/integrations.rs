//! Connected-tool routes and the sort worker, served by the host.
//!
//! No chat model router exists in this server yet, so sorting reports "no model" and the sort
//! state stays honest until one is wired in.
use std::{
    sync::{atomic::AtomicBool, atomic::Ordering, Arc},
    time::Duration,
};

use async_trait::async_trait;
use axum::Router;
use moss_integrations::sortmap::SortedBy;
use moss_integrations_host::{
    jobs::SortJobs,
    manifest::queue_specs,
    mcp::McpDiscoverer,
    ports::{ModelFailure, SortModel},
    routes::{router, Integrations},
};
use moss_platform_jobs::{Queue, Role};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::SecretCipher,
};
use uuid::Uuid;

/// Stands in until a chat model router exists.
struct NoModel;

#[async_trait]
impl SortModel for NoModel {
    async fn select(&self, _: Uuid) -> Option<SortedBy> {
        None
    }
    async fn run(&self, _: Uuid, _: &str, _: u32) -> Result<String, ModelFailure> {
        Err(ModelFailure::NotReady)
    }
}

pub struct Wiring {
    pub producer_url: String,
    pub worker_url: String,
    pub key: String,
}

/// Builds the routes and starts the worker loop, which stops when `stop` is set.
pub async fn routes(app: Database, wiring: Wiring, stop: Arc<AtomicBool>) -> Result<Router, String> {
    let cipher = SecretCipher::integrations(&[("JARVIS_INTEGRATIONS_SECRET_KEY".into(), wiring.key)].into())
        .map_err(|e| e.to_string())?;
    let cipher = Arc::new(cipher);
    let producer = Queue::connect(&wiring.producer_url, Role::Producer, queue_specs())
        .await
        .map_err(|_| "integrations queue".to_owned())?;
    let worker = Queue::connect(&wiring.worker_url, Role::Worker, queue_specs())
        .await
        .map_err(|_| "integrations worker queue".to_owned())?;
    let worker_db = Database::connect(&wiring.worker_url, 4, RuntimeRole::Worker).await?;
    let model: Arc<dyn SortModel> = Arc::new(NoModel);
    let jobs = SortJobs { db: worker_db, cipher: Some(cipher.clone()), model: model.clone() };
    tokio::spawn(async move {
        while !stop.load(Ordering::Relaxed) {
            match worker.run_one(&jobs).await {
                Ok(true) => continue,
                _ => tokio::time::sleep(Duration::from_secs(2)).await,
            }
        }
    });
    Ok(router(Arc::new(Integrations {
        db: app,
        cipher: Some(cipher),
        discoverer: Arc::new(McpDiscoverer::default()),
        model,
        queue: Some(Arc::new(producer)),
    })))
}
