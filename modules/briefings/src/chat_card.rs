//! The `prepareBriefingAction` public call. It builds the approval card for a chat re-run from the
//! caller's own briefing. It never grants approval and never queues a run.
use crate::tools::{resolve_owned, selector, version, RERUN};
use crate::util::call;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Value};

fn label_of(kind: &str) -> &'static str {
    match kind {
        "morning" => "Morning",
        "evening" => "Evening",
        _ => "Weekly review",
    }
}

fn card<H: Host + ?Sized>(host: &H, tool: &str, input: &Value) -> Result<Value> {
    if tool != RERUN || selector(input).is_err() {
        return Ok(Value::Null);
    }
    let (id, kind) = selector(input).unwrap_or((None, None));
    let actor = call(host)?.actor;
    let Some(definition) = resolve_owned(host, &actor, id, kind)? else { return Ok(Value::Null) };
    let title = definition["title"].as_str().unwrap_or_default();
    // A definition id in the input must be the one shown, so the card names the briefing.
    let field = match (id, kind) {
        (Some(_), _) => json!({"label":"Briefing","value":title}),
        (_, Some(kind)) => json!({"label":"Briefing type","value":label_of(kind)}),
        _ => return Ok(Value::Null),
    };
    Ok(json!({
        "title": "Re-run a briefing",
        "content": "user_authored",
        "target": title,
        "fields": [field],
        "version": version(&definition)?,
    }))
}

/// Refusals the old card gave stay a missing card. A host failure is a fixed message.
pub fn prepare<H: Host + ?Sized>(host: &H, tool: &str, input_json: &str) -> Value {
    let Ok(input) = serde_json::from_str::<Value>(input_json) else { return json!({"ok":null}) };
    match card(host, tool, &input) {
        Ok(card) => json!({"ok":card}),
        Err(_) => json!({"error":{"statusCode":503,"error":"Briefings service is unavailable"}}),
    }
}
