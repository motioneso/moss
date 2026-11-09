//! Background jobs. The host captures the actor in the queue envelope, so a job
//! can only touch rows that actor can already see.
use crate::{events, Error, Result};
use moss_module_sdk::{query::Filter, query::Query, Host};
use serde::Deserialize;
use serde_json::{json, Value};

pub const CACHE_EVICT: &str = "calendar-cache-evict-event";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    queue: String,
    parameters: EvictParameters,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
struct EvictParameters {
    target_item_id: String,
}

pub fn handle(host: &impl Host, payload: &str) -> Result<Value> {
    let job: Job = serde_json::from_str(payload)?;
    if job.queue != CACHE_EVICT {
        return Err(Error::new(404, "Unknown Calendar queue"));
    }
    let id = job.parameters.target_item_id;
    let mut q = Query::select(Filter::eq("id", id.as_str()));
    q.limit = Some(1);
    if crate::query(host, events::TABLE, &q)?.is_empty() {
        return Ok(json!({"evicted":false}));
    }
    host.call("db", "delete", events::TABLE, json!({"id":id}))?;
    Ok(json!({"evicted":true}))
}
