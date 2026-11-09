//! Bounded publication recovery for a trusted future server timer. No indexing
//! runs here. Ordinary packages do not expose this experimental API.
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

const PAGE_SIZE: u32 = 25;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Recovery {
    after: Option<String>,
}

/// Scan the caller's private checkpoints in stable UUID order, with no OFFSET.
/// Retry a failed page with the same cursor; only advance after finalization
/// succeeds. Restart from no cursor periodically to notice new lower UUIDs.
/// Queue idempotency and saved worker results make duplicate requests safe.
pub(crate) fn recover(host: &impl Host, input: Recovery) -> Result<Value> {
    let filter = match input.after {
        Some(after) => Filter::Compare {
            column: "id".into(),
            op: Compare::Gt,
            value: json!(uuid::Uuid::parse_str(&after)
                .map_err(|_| unavailable())?
                .to_string()),
        },
        None => Filter::All,
    };
    let mut query = Query::select(filter);
    query.limit = Some(PAGE_SIZE);
    query.order = vec![Order {
        column: "id".into(),
        descending: false,
    }];
    let rows = Client(host).query(crate::sync_worker::TABLE, &query)?;
    let context = host.call("context", "read", "call", json!({}))?;
    let now = context["now"].as_str().ok_or_else(unavailable)?;
    let mut requested = 0;
    for row in &rows {
        let id = row["id"].as_str().ok_or_else(unavailable)?;
        uuid::Uuid::parse_str(id).map_err(|_| unavailable())?;
        let checkpoint = row["checkpoint"].as_object().ok_or_else(unavailable)?;
        // Successful parents have already committed their child row in the same
        // transaction. That unfinished child is independently discoverable here.
        if !checkpoint.contains_key("workerResult") {
            crate::sync_worker::publish(host, id, now)?;
            requested += 1;
        }
    }
    Ok(json!({
        "scanned":rows.len(), "requested":requested,
        "nextCursor":if rows.len() == PAGE_SIZE as usize {
            rows.last().map(|row| row["id"].clone())
        } else { None }
    }))
}
fn unavailable() -> Error {
    Error::new("Notes sync recovery is unavailable")
}
