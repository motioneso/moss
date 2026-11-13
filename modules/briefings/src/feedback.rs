//! The `verifyBriefingFeedbackTarget` public call. The feedback owner asks whether a target is
//! really the caller's own briefing before it stores a rating. The run is read from the caller's
//! own rows, never from what the caller sends. A briefing item may only be named by the id the
//! stored signals or catch-up entries give.
use crate::runs::{is_fallback, is_uuid, signal_item_id, TABLE};
use crate::util::call;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verify {
    pub target_kind: String,
    pub target_ref: String,
    pub surface: String,
    /// The feedback owner's stored record for an item, when it has one.
    pub stored: Option<Stored>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stored {
    pub source_kind: Option<String>,
    pub source_label: Option<String>,
    pub priority_band: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

fn version(parts: Value) -> String {
    Sha256::digest(parts.to_string().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn owned_run<H: Host + ?Sized>(host: &H, actor: &str, id: &str) -> Result<Option<Value>> {
    if !is_uuid(id) {
        return Ok(None);
    }
    let query = Query::select(Filter::And {
        filters: vec![Filter::eq("id", id), Filter::eq("owner_user_id", actor)],
    });
    Ok(Client(host).query(TABLE, &query)?.into_iter().next())
}

/// The full text of one item, found in the run's own record.
fn item_label(run: &Value, target_ref: &str) -> Option<String> {
    let metadata = &run["source_metadata"];
    let mut labels: Vec<String> = Vec::new();
    let mut add = |text: String| {
        if !labels.contains(&text) {
            labels.push(text);
        }
    };
    for (kind, key) in [("calendar", "calendarSignals"), ("email", "emailSignals")] {
        for signal in metadata[key].as_array().into_iter().flatten() {
            let (Some(kind_of), Some(summary)) = (signal["type"].as_str(), signal["summary"].as_str()) else {
                continue;
            };
            if signal_item_id(kind, kind_of, summary) == target_ref {
                add(summary.to_owned());
            }
        }
    }
    for entry in metadata["structuredPayload"]["catchUp"]["entries"].as_array().into_iter().flatten() {
        let (Some(id), Some(summary)) = (entry["id"].as_str(), entry["summary"].as_str()) else { continue };
        if id != target_ref {
            continue;
        }
        add(match entry["senderName"].as_str() {
            Some(sender) => format!("{sender}\n{summary}"),
            None => summary.to_owned(),
        });
    }
    (!labels.is_empty()).then(|| labels.join("\n\n"))
}

fn card<H: Host + ?Sized>(host: &H, request: &Verify) -> Result<Value> {
    let actor = call(host)?.actor;
    match (request.target_kind.as_str(), request.surface.as_str()) {
        ("briefing_run", "briefing") => {
            let Some(run) = owned_run(host, &actor, &request.target_ref)? else { return Ok(Value::Null) };
            // A run written without the model has no reader-facing text.
            let shown = if is_fallback(&run["source_metadata"]) { "" } else { run["summary_text"].as_str().unwrap_or("") };
            Ok(json!({
                "ownerUserId": actor,
                "targetKind": request.target_kind,
                "targetRef": request.target_ref,
                "surface": request.surface,
                "sourceKind": "briefing",
                "sourceLabel": "Briefing",
                "approvalTarget": {"label": shown, "version": version(json!([run["id"], shown]))},
                "metadata": {"briefingType": run["briefing_type"]},
                "canRemember": false,
            }))
        }
        ("briefing_item", _) => {
            let Some(stored) = &request.stored else { return Ok(Value::Null) };
            let Some(run_id) = stored.metadata["briefingRunId"].as_str() else { return Ok(Value::Null) };
            let run = owned_run(host, &actor, run_id)?;
            let label = run.as_ref().and_then(|run| item_label(run, &request.target_ref));
            let mut out = json!({
                "ownerUserId": actor,
                "targetKind": request.target_kind,
                "targetRef": request.target_ref,
                "surface": request.surface,
                "sourceKind": stored.source_kind,
                "sourceLabel": stored.source_label,
                "priorityBand": stored.priority_band,
                "metadata": stored.metadata,
                "canRemember": false,
            });
            if let (Some(label), Some(run)) = (label, run) {
                out["approvalTarget"] = json!({
                    "label": label,
                    "version": version(json!([run["id"], request.target_ref, label])),
                });
            }
            Ok(out)
        }
        _ => Ok(Value::Null),
    }
}

pub fn verify<H: Host + ?Sized>(host: &H, request: &Verify) -> Value {
    match card(host, request) {
        Ok(record) => json!({"ok":record}),
        Err(_) => json!({"error":{"statusCode":503,"error":"Briefings service is unavailable"}}),
    }
}
