//! Replays the old handlers beside the installed package.
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
            let time = text.len() >= 20
                && text.as_bytes()[10] == b'T'
                && (text.ends_with('Z') || text.ends_with("+00:00"));
            if id {
                *text = "<id>".into();
            } else if time {
                *text = "<time>".into();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(mask),
        Value::Object(fields) => fields.values_mut().for_each(mask),
        _ => {}
    }
}

pub fn old_tool(actor: uuid::Uuid, role: &str, tool: &str, parameters: Value) -> Value {
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/meals/tools/tools-oracle.ts"])
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
            json!({"actor":actor,"role":role,"tool":tool,"parameters":parameters})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Legacy tools failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
