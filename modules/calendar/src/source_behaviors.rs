//! Calendar's source behaviors: what the assistant may do with the calendar.
//! The stored value is the account's `sourceBehaviors` preference blob, so the
//! existing app and this package read and write the same toggles.
use crate::{Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const RESOURCE: &str = "calendar.source-behaviors";

/// id, name, description, default ("on", "off" or "soon").
const BEHAVIORS: [(&str, &str, &str, &str); 4] = [
    (
        "calendar.briefings",
        "Include in briefings",
        "Surface today's events in the morning reading.",
        "default-on",
    ),
    (
        "calendar.planning",
        "Use for planning",
        "Let scheduled briefings turn your meetings into saved day-plan blocks automatically.",
        "default-on",
    ),
    (
        "calendar.detect-commitments",
        "Detect commitments",
        "Turn meeting language into a tracked commitment.",
        "coming-soon",
    ),
    (
        "calendar.writeback",
        "Write events back",
        "Let saved day-plan additions write to your calendar when applied or scheduled.",
        "default-on",
    ),
];

fn view(stored: &Value) -> Value {
    let behaviors: Vec<Value> = BEHAVIORS
        .iter()
        .map(|(id, name, description, default)| {
            let toggleable = *default != "coming-soon";
            let enabled = toggleable
                && stored[*id]
                    .as_bool()
                    .unwrap_or(*default == "default-on");
            json!({"id":id,"sourceId":"calendar","name":name,"description":description,
                "default":default,"enabled":enabled,"toggleable":toggleable})
        })
        .collect();
    json!({"sources":[{"id":"calendar","name":"Calendar",
        "description":"What your assistant is allowed to do with your calendar, independent of whichever service powers it.",
        "behaviors":behaviors}]})
}

pub fn read(host: &impl Host) -> Result<Value> {
    Ok(view(&host.call("kv", "get", RESOURCE, json!({}))?))
}

pub fn save(host: &impl Host, id: &str, body: &Value) -> Result<Value> {
    let enabled = match body.as_object() {
        Some(object) if object.len() == 1 => body["enabled"].as_bool(),
        _ => None,
    }
    .ok_or_else(|| Error::new(400, "Invalid source behavior request"))?;
    let Some((_, _, _, default)) = BEHAVIORS.iter().find(|b| b.0 == id) else {
        return Err(Error::new(404, "Source behavior not found"));
    };
    if *default == "coming-soon" {
        return Err(Error::new(422, "Source behavior is not available yet"));
    }
    let stored = host.call("kv", "set", RESOURCE, json!({"id":id,"enabled":enabled}))?;
    Ok(view(&stored))
}
