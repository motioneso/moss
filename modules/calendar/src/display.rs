//! Presentation preferences use account-scoped package KV. They grant no writeback authority.
use crate::{Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub fn read(host: &impl Host) -> Result<Value> {
    let locale = host.call("kv", "get", "calendar.chat-context", json!({}))?;
    let saved = host.call("kv", "get", "calendar.ui-view", json!({}))?;
    let now = crate::context(host, "read", "call")?;
    Ok(
        json!({"timezone":locale["timezone"],"dateFormat":if locale["dateFormat"] == "12" {"12"} else {"24"},"now":now["now"],"view":saved,"assistantName":crate::model::assistant_name(&locale["assistantName"])}),
    )
}
pub fn save(host: &impl Host, body: Value) -> Result<Value> {
    let object = body
        .as_object()
        .ok_or_else(|| Error::new(400, "Invalid calendar view"))?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "view" | "cursor" | "workWeek"))
        || !matches!(body["view"].as_str(), Some("day" | "week" | "month"))
        || body["workWeek"].as_bool().is_none()
        || body["cursor"]
            .as_str()
            .filter(|s| s.len() == 10)
            .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .is_none()
    {
        return Err(Error::new(400, "Invalid calendar view"));
    }
    host.call("kv", "set", "calendar.ui-view", body.clone())?;
    Ok(json!({"view":body}))
}
