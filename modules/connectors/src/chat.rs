//! Adapt the shared chat envelope to the saved-message reply preview.
use crate::{email_writes, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

pub fn prepare(host: &impl Host, input: &Value) -> Result<Value> {
    let action = match input["tool"].as_str() {
        Some("email.sendReply") => "Send reply",
        Some("email.draftReply") => "Save reply draft",
        _ => return Err(Error::new(400, "Unknown email action")),
    };
    let mut card = email_writes::prepare(host, &input["parameters"])?;
    // The common host sets the target from module metadata. Keep the recipient under To only.
    card.as_object_mut().unwrap().remove("target");
    card.as_object_mut().unwrap().remove("title");
    card["fields"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"label":"Action","value":action}));
    Ok(card)
}

pub fn completed_draft(parameters: &Value, mut result: Value) -> Value {
    if result["data"]["ok"] == true {
        result["data"]["changed"] = json!([{"label":"Reply draft","before":"No new draft","after":parameters["body"].as_str().unwrap_or("")}]);
    }
    result
}
