//! Tool sorting as a background job. The payload holds a connection id and an operation name,
//! never tool text or a credential. Each model call runs in two transactions, as the old job did.
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use moss_integrations::{
    names::readable_tool_names,
    sort::{
        call_prompt, call_results, failed_results, plan_calls, results_without_call, sorting_targets, with_sorted_by, CallTool, CredentialMatcher,
        TargetsInput, MAX_OUTPUT_TOKENS,
    },
    sortmap::{SortFailure, SortedBy},
    tool::Tool,
};
use moss_platform_contracts::{Actor, Error as QueueError, Metadata};
use moss_platform_jobs::{JobHandler, Queue};
use access_context::AccessContext;
use safety_core::{
    db::{DataContext, Database},
    secret::SecretCipher,
};
use serde_json::json;
use uuid::Uuid;

use crate::{
    manifest::{manifest_hash, MODULE_ID, SORT_QUEUE},
    ports::{parse_model_reply, ModelFailure, SortModel},
    store,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Sort,
    Retry,
    ModelReady,
}

impl Op {
    pub fn name(self) -> &'static str {
        match self {
            Op::Sort => "sort",
            Op::Retry => "retry",
            Op::ModelReady => "model_ready",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "retry" => Op::Retry,
            "model_ready" => Op::ModelReady,
            _ => Op::Sort,
        }
    }
}

/// Queues one sort for a connection. Fails only when the queue refuses.
pub async fn enqueue_sort(
    queue: &Queue,
    actor: Uuid,
    connection_id: &str,
    op: Op,
) -> Result<(), QueueError> {
    let payload = json!({
        "actorUserId": actor,
        "moduleId": MODULE_ID,
        "jobKind": SORT_QUEUE,
        "manifestHash": manifest_hash(),
        "params": { "connectionId": connection_id, "op": op.name() },
    });
    queue
        .enqueue(
            Actor::from_authenticated_session(actor, Uuid::new_v4()),
            SORT_QUEUE,
            payload,
            Uuid::new_v4(),
            Utc::now(),
        )
        .await
        .map(|_| ())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    NothingToSort,
    NoModel,
    CredentialsPaused,
    Sorted { calls: usize, written: usize },
    Stopped { calls: usize, written: usize },
}

pub struct SortJobs {
    pub db: Database,
    pub cipher: Option<Arc<SecretCipher>>,
    pub model: Arc<dyn SortModel>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn targets_for(row: &store::Row, op: Op) -> Vec<Tool> {
    sorting_targets(&TargetsInput {
        tools: &row.discovered_tools,
        sort: &row.classifier_sort,
        retry_failed: op == Op::Retry,
        retry_no_model: op == Op::ModelReady,
        now_ms: Utc::now().timestamp_millis(),
    })
}

struct Prepared {
    sorted_by: Option<SortedBy>,
    calls: Vec<Vec<CallTool>>,
    free: std::collections::BTreeMap<String, String>,
    written: usize,
}

impl SortJobs {
    fn access(actor: Uuid) -> AccessContext {
        AccessContext::new(actor, Uuid::new_v4())
    }

    /// The stored credential, opened. `Err(())` means it exists but cannot be opened, so the
    /// sort pauses. `Ok(None)` means the connection has none.
    async fn credential(&self, db: &tokio_postgres::Client, id: &str) -> Result<Option<String>, ()> {
        let Some(envelope) = store::credential_envelope(db, id).await.map_err(|_| ())? else {
            return Ok(None);
        };
        let cipher = self.cipher.as_ref().ok_or(())?;
        let fields = cipher.open(&envelope).map_err(|_| ())?;
        Ok(fields.get("secret").map(|s| s.expose_secret().to_owned()))
    }

    pub async fn run(&self, actor: Uuid, connection_id: &str, op: Op) -> Result<Outcome, QueueError> {
        let access = Self::access(actor);
        let db_err = |_| QueueError::Database;

        let cx = DataContext::open(&self.db, &access).await.map_err(db_err)?;
        let first = self.first_transaction(&cx, actor, connection_id, op).await;
        let prepared = match first {
            Ok(Ok(p)) => {
                cx.commit().await.map_err(db_err)?;
                p
            }
            Ok(Err(outcome)) => {
                cx.commit().await.map_err(db_err)?;
                return Ok(outcome);
            }
            Err(error) => return Err(error),
        };

        let (mut written, mut calls) = (prepared.written, 0usize);
        for planned in &prepared.calls {
            let cx = DataContext::open(&self.db, &access).await.map_err(db_err)?;
            let Some(row) = store::get(cx.db(), connection_id, true).await.map_err(|_| QueueError::Database)?
            else {
                continue;
            };
            let current: std::collections::BTreeSet<String> =
                targets_for(&row, op).iter().map(|t| moss_integrations::tool::sort_fingerprint(t)).collect();
            let kept: Vec<CallTool> = planned
                .iter()
                .filter(|c| current.contains(&moss_integrations::tool::sort_fingerprint(&c.tool)))
                .cloned()
                .collect();
            if !kept.is_empty() {
                let tools: Vec<Tool> = kept.iter().map(|c| c.tool.clone()).collect();
                let marked = failed_results(&tools, SortFailure::Interrupted, &now_iso());
                store::save_sorts(cx.db(), connection_id, &marked).await.map_err(|_| QueueError::Database)?;
            }
            cx.commit().await.map_err(db_err)?;
            if kept.is_empty() {
                continue;
            }

            let cx = DataContext::open(&self.db, &access).await.map_err(db_err)?;
            let results = self.run_call(actor, &kept, &prepared).await;
            calls += 1;
            let Some(results) = results else {
                cx.commit().await.map_err(db_err)?;
                return Ok(Outcome::Stopped { calls, written });
            };
            store::save_sorts(cx.db(), connection_id, &results).await.map_err(|_| QueueError::Database)?;
            cx.commit().await.map_err(db_err)?;
            written += results.len();
        }
        Ok(Outcome::Sorted { calls, written })
    }

    async fn first_transaction(
        &self,
        cx: &DataContext,
        actor: Uuid,
        id: &str,
        op: Op,
    ) -> Result<Result<Prepared, Outcome>, QueueError> {
        let Some(row) = store::get(cx.db(), id, false).await.map_err(|_| QueueError::Database)? else {
            return Ok(Err(Outcome::NothingToSort));
        };
        if row.discovered_tools.is_empty() {
            return Ok(Err(Outcome::NothingToSort));
        }
        let targets = targets_for(&row, op);
        if targets.is_empty() {
            return Ok(Err(Outcome::NothingToSort));
        }
        let Some(sorted_by) = self.model.select(actor).await else {
            if op != Op::ModelReady {
                let failed = failed_results(&targets, SortFailure::NoModel, &now_iso());
                store::save_sorts(cx.db(), id, &failed).await.map_err(|_| QueueError::Database)?;
            }
            return Ok(Err(Outcome::NoModel));
        };
        let credential = match self.credential(cx.db(), id).await {
            Ok(value) => value,
            Err(()) => return Ok(Err(Outcome::CredentialsPaused)),
        };
        let plan = plan_calls(&targets, &CredentialMatcher::new(credential.as_deref()));
        let free = readable_tool_names(&row.discovered_tools);
        let settled = results_without_call(&plan, &free, &now_iso());
        if !settled.is_empty() {
            store::save_sorts(cx.db(), id, &settled).await.map_err(|_| QueueError::Database)?;
        }
        Ok(Ok(Prepared { sorted_by: Some(sorted_by), calls: plan.calls, free, written: settled.len() }))
    }

    /// One model call. `None` means the call stopped without a reply and nothing is written.
    async fn run_call(&self, actor: Uuid, call: &[CallTool], prepared: &Prepared) -> Option<Vec<moss_integrations::sort::ToolResult>> {
        let prompt = call_prompt(call);
        let at = now_iso();
        let results = match self.model.run(actor, &prompt, MAX_OUTPUT_TOKENS).await {
            Err(ModelFailure::NotReady) => return None,
            Err(ModelFailure::Error) => {
                let tools: Vec<Tool> = call.iter().map(|c| c.tool.clone()).collect();
                return Some(failed_results(&tools, SortFailure::Error, &at));
            }
            Ok(text) => {
                let raw = parse_model_reply(&text).unwrap_or(serde_json::Value::Null);
                call_results(call, &raw, &prepared.free, &at)
            }
        };
        Some(with_sorted_by(results, prepared.sorted_by.as_ref()))
    }

    /// Queue a sort for every connection with a tool that was never sorted. `client` is a
    /// connection as the worker role, which may call the listing function.
    pub async fn sweep(queue: &Queue, client: &tokio_postgres::Client) -> Result<usize, QueueError> {
        let rows = store::needing_sort(client).await.map_err(|_| QueueError::Database)?;
        for (owner, id) in &rows {
            let owner = Uuid::parse_str(owner).map_err(|_| QueueError::InvalidPayload)?;
            enqueue_sort(queue, owner, id, Op::Sort).await?;
        }
        Ok(rows.len())
    }
}

#[async_trait]
impl JobHandler for SortJobs {
    async fn execute_in_data_context(&self, actor: Actor, metadata: &Metadata) -> Result<(), QueueError> {
        let params = metadata.params().ok_or(QueueError::InvalidPayload)?;
        let id = params["connectionId"].as_str().ok_or(QueueError::InvalidPayload)?;
        let op = Op::parse(params["op"].as_str().unwrap_or("sort"));
        self.run(actor.user_id(), id, op).await.map(|_| ())
    }
}
