//! Opt-in queue publication after the outer database adapter commits. A publication
//! failure is returned to the worker, whose immutable command can be retried.
use crate::runtime::{CallScope, Ports, Request};
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub struct AfterCommitJobs {
    next: Arc<dyn Ports>,
    pending: Mutex<BTreeMap<Uuid, Vec<Request>>>,
}
impl AfterCommitJobs {
    /// Place inside TransactionalDatabasePorts, outside services which need no
    /// finalization. The outer adapter must call finish after commit or rollback.
    pub fn new(next: Arc<dyn Ports>) -> Self {
        Self {
            next,
            pending: Mutex::new(BTreeMap::new()),
        }
    }
}
impl Ports for AfterCommitJobs {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "jobs" || request.operation != "enqueue-after-commit" {
            return self.next.invoke(scope, port, request);
        }
        crate::runtime::authorize(scope.module(), port, request)?;
        let mut publish = request.clone();
        publish.operation = "enqueue-options".into();
        // Check the downstream publication capability now, before the DB commits.
        crate::runtime::authorize(scope.module(), port, &publish)?;
        let mut calls = self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Deferred jobs busy"))?;
        let pending = calls.entry(scope.call_id()).or_default();
        ensure!(pending.len() < 1000, "Too many deferred jobs");
        pending.push(publish);
        Ok(json!({"deferred":true}))
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Deferred jobs busy"))?
            .remove(&scope.call_id())
            .unwrap_or_default();
        self.next.finish_call(scope, success)?;
        if success {
            for request in pending {
                self.next.invoke(scope, "jobs", &request)?;
            }
        }
        Ok(())
    }
}
