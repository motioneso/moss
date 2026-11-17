//! Replays the old routes against the installed package, step for step.
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};

/// Ids and times differ between two runs, so both sides are compared with them masked.
pub fn mask(value: &mut Value) {
    match value {
        Value::String(text) => {
            let id = text.len() == 36 && text.matches('-').count() == 4;
            let time = text.len() >= 20 && text.as_bytes()[10] == b'T' && text.ends_with('Z');
            if id {
                *text = "<id>".into();
            } else if time {
                *text = "<time>".into();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(mask),
        Value::Object(fields) => {
            if let Some(Value::String(token)) = fields.get("nextCursor") {
                // A cursor holds a time and an id, so only its shape is compared.
                use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
                let inner: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token).unwrap()).unwrap();
                let keys: Vec<&String> = inner.as_object().unwrap().keys().collect();
                let shape = format!("<cursor {keys:?}>");
                fields.insert("nextCursor".into(), Value::String(shape));
            }
            fields.values_mut().for_each(mask)
        }
        _ => {}
    }
}

/// The old server's answers for one person's steps.
pub fn old_routes(actor: uuid::Uuid, steps: &[Value], vars: &Value) -> Vec<Value> {
    let vars_map: serde_json::Map<String, Value> = vars.as_object().cloned().unwrap_or_default();
    let mut filled = steps.to_vec();
    for step in &mut filled {
        if let Some(url) = step["url"].as_str().map(str::to_owned) {
            let mut out = url;
            for (name, value) in &vars_map {
                out = out.replace(&format!("{{{name}}}"), value.as_str().unwrap_or_default());
            }
            step["url"] = json!(out);
        }
    }
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/wellness/tools/routes-oracle.ts"])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"actor":actor,"steps":filled,"vars":{}})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "Old route oracle failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let parsed: Value = serde_json::from_slice(&out.stdout).unwrap();
    parsed["responses"].as_array().unwrap().clone()
}
