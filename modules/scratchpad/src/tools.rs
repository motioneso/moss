//! Chat reads and additive writes. Approval is enforced by the host tools port.
use crate::{
    routes::{is_js_space, js_len},
    store::call,
};
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub tool: String,
    pub parameters: Value,
}

pub fn execute<H: Host + ?Sized>(host: &H, request: Request) -> Result<Value> {
    match request.tool.as_str() {
        "scratchpad.read" => {
            let note = call(host, "get", json!({}))?;
            Ok(
                json!({"data":{"body":note["body"], "characterCount":js_len(note["body"].as_str().unwrap_or("")),
                "revision":note["revision"], "updatedAt":note["updatedAt"]}}),
            )
        }
        "scratchpad.append" => {
            let text = request.parameters["text"]
                .as_str()
                .unwrap_or("")
                .trim_matches(is_js_space);
            if text.is_empty() {
                return Ok(json!({"data":{"error":"Cannot append empty text to the scratchpad"}}));
            }
            if js_len(text) > 2000 {
                return Ok(
                    json!({"data":{"error":"Text is too long to append in one call (2000 character limit)"}}),
                );
            }
            let added = call(host, "append", json!({"text":text}))?;
            if added["tooLarge"] == true {
                return Ok(json!({"data":{"error":"Scratchpad is full"}}));
            }
            Ok(
                json!({"data":{"revision":added["revision"],"updatedAt":added["updatedAt"],"appended":added["appended"],"changed":[{"label":"Text appended","before":"","after":added["appended"]}]}}),
            )
        }
        _ => Err(Error::new("Unknown Scratchpad tool")),
    }
}

/// Code, not a model, builds the card. Current note text is not copied into it.
pub fn prepare<H: Host + ?Sized>(host: &H, parameters: &Value) -> Result<Value> {
    let Some(fields) = parameters.as_object().filter(|p| p.len() == 1) else {
        return Ok(Value::Null);
    };
    let Some(text) = fields.get("text").and_then(Value::as_str) else {
        return Ok(Value::Null);
    };
    if text.trim_matches(is_js_space).is_empty() || js_len(text) > 2000 {
        return Ok(Value::Null);
    }
    let note = call(host, "get", json!({}))?;
    Ok(
        json!({"content":"user_authored", "target":"Your scratchpad",
        "fields":[{"label":"Text to append","value":text}],
        "revision":note["revision"], "characterCount":js_len(note["body"].as_str().unwrap_or(""))}),
    )
}

/// Settings route approval uses the same labels and values as the legacy presentation.
pub fn prepare_settings<H: Host + ?Sized>(host: &H, parameters: &Value) -> Result<Value> {
    let Some(input) = parameters.as_object().filter(|p| !p.is_empty()) else {
        return Ok(Value::Null);
    };
    let mut fields = Vec::new();
    for (key, value) in input {
        let (label, shown) = match key.as_str() {
            "syncToNotes" => match value.as_bool() {
                Some(flag) => (
                    "Copy scratchpad to your connected notes folder",
                    if flag { "Yes" } else { "No" }.to_owned(),
                ),
                None => return Ok(Value::Null),
            },
            "shortcut" => match value.as_str() {
                Some(text) if crate::shortcut::is_valid(text) => {
                    ("Keyboard shortcut", text.to_owned())
                }
                _ => return Ok(Value::Null),
            },
            _ => return Ok(Value::Null),
        };
        fields.push(json!({"label":label,"value":shown}));
    }
    let note = call(host, "get", json!({}))?;
    Ok(
        json!({"content":"user_authored","target":"Your scratchpad settings","fields":fields,
        "revision":note["revision"],"syncToNotes":note["syncToNotes"],"notesFolderConfigured":note["notesFolderConfigured"],"shortcut":note["shortcut"]}),
    )
}

/// Adapt the chat host envelope to the existing append card builder.
pub fn prepare_chat<H: Host + ?Sized>(host: &H, input: &Value) -> Result<Value> {
    if input["tool"] != "scratchpad.append" {
        return Err(Error::new("Unknown Scratchpad card tool"));
    }
    prepare(host, &input["parameters"])
}
