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
    // The legacy preview classifies content; chat renders this field as visible text.
    card.as_object_mut().unwrap().remove("content");
    card["fields"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"label":"Action","value":action}));
    Ok(card)
}

pub fn completed_draft(parameters: &Value, mut result: Value) -> Value {
    if result["data"]["ok"] == true {
        let body = parameters["body"].as_str().unwrap_or("");
        let after = if body.len() <= 8192 {
            body.to_string()
        } else {
            let mut end = 8100;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            format!("{} … (open your mailbox for the full draft)", &body[..end])
        };
        result["data"]["changed"] =
            json!([{"label":"Reply draft","before":"No new draft","after":after}]);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_unicode_drafts_keep_their_done_receipt() {
        let data = completed_draft(
            &json!({"body":"🥦".repeat(4000)}),
            json!({"data":{"ok":true}}),
        );
        let after = data["data"]["changed"][0]["after"].as_str().unwrap();
        assert!(after.len() <= 8192);
        assert!(after.ends_with("(open your mailbox for the full draft)"));
    }
}
