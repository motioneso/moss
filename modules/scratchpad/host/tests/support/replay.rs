//! Replays the old routes against the installed package, step for step.
use serde_json::{json, Value};
use std::{io::Write, process::{Command, Stdio}};

/// Times differ between two runs, so both sides are compared with them masked.
pub fn mask(value: &mut Value) {
    match value {
        Value::String(text) => {
            if text.len() >= 20 && text.as_bytes()[10] == b'T' && text.ends_with('Z') {
                *text = "<time>".into();
            }
        }
        Value::Number(number) => *number = serde_json::Number::from_f64(number.as_f64().unwrap()).unwrap(),
        Value::Array(items) => items.iter_mut().for_each(mask),
        Value::Object(fields) => fields.values_mut().for_each(mask),
        _ => {}
    }
}

/// The old server's answers for one person's steps.
pub fn old_routes(actor: uuid::Uuid, steps: &[Value]) -> Vec<Value> {
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/scratchpad/tools/routes-oracle.ts"])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(json!({"actor": actor, "steps": steps}).to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "Old route oracle failed: {}", String::from_utf8_lossy(&out.stderr));
    let parsed: Value = serde_json::from_slice(&out.stdout).unwrap();
    parsed["responses"].as_array().unwrap().clone()
}

/// Where the package serves what the old server served under `/api/scratchpad`.
pub fn new_path(old: &str) -> &'static str {
    match old {
        "/api/scratchpad" => "/note",
        "/api/scratchpad/append" => "/append",
        "/api/scratchpad/settings" => "/settings",
        other => panic!("unmapped route {other}"),
    }
}

pub fn steps_without_a_notes_folder() -> Vec<Value> {
    let (note, put, post, patch) = ("/api/scratchpad", "PUT", "POST", "PATCH");
    let at = |m: &str, u: &str, b: Value| json!({"method": m, "url": u, "body": b});
    let max = "x".repeat(64000);
    let emoji_fits = "\u{1F600}".repeat(32000);
    let emoji_over = "\u{1F600}".repeat(32001);
    vec![
        json!({"method": "GET", "url": note}),
        at(put, note, json!({"body": "one", "revision": 0})),
        at(put, note, json!({"body": "stale", "revision": 0})),
        at(put, note, json!({"body": "two", "revision": 1})),
        json!({"method": "GET", "url": note}),
        at(put, note, json!({"body": "float ok", "revision": 2.0})),
        at(put, note, json!({"body": "x", "revision": -1})),
        at(put, note, json!({"body": "x", "revision": 1.5})),
        at(put, note, json!({"body": "x", "revision": "3"})),
        at(put, note, json!({"body": "x"})),
        at(put, note, json!({"revision": 3})),
        at(put, note, json!({"body": 3, "revision": 3})),
        at(put, note, json!({"body": ["x"], "revision": 3})),
        at(put, note, json!(null)),
        at(put, note, json!(["x"])),
        at(put, note, json!("x")),
        at(put, note, json!({"body": "", "revision": 3})),
        at(put, note, json!({"body": max, "revision": 4})),
        at(put, note, json!({"body": format!("{max}y"), "revision": 5})),
        at(post, "/api/scratchpad/append", json!({"text": "y"})),
        at(put, note, json!({"body": emoji_fits, "revision": 5})),
        at(put, note, json!({"body": emoji_over, "revision": 6})),
        at(put, note, json!({"body": "short", "revision": 6})),
        at(post, "/api/scratchpad/append", json!({"text": "  hello  "})),
        at(post, "/api/scratchpad/append", json!({"text": "\u{a0} spaced \u{2003}"})),
        at(post, "/api/scratchpad/append", json!({"text": ""})),
        at(post, "/api/scratchpad/append", json!({"text": "   \n\t "})),
        at(post, "/api/scratchpad/append", json!({"text": 3})),
        at(post, "/api/scratchpad/append", json!({})),
        at(post, "/api/scratchpad/append", json!(null)),
        at(post, "/api/scratchpad/append", json!({"text": max.clone() + "z"})),
        json!({"method": "GET", "url": note}),
        at(patch, "/api/scratchpad/settings", json!({})),
        at(patch, "/api/scratchpad/settings", json!({"shortcut": "alt+j"})),
        at(patch, "/api/scratchpad/settings", json!({"shortcut": "mod+shift+s"})),
        at(patch, "/api/scratchpad/settings", json!({"shortcut": "ctrl+k"})),
        at(patch, "/api/scratchpad/settings", json!({"shortcut": "shift+s"})),
        at(patch, "/api/scratchpad/settings", json!({"shortcut": ""})),
        at(patch, "/api/scratchpad/settings", json!({"shortcut": 3})),
        at(patch, "/api/scratchpad/settings", json!({"shortcut": null})),
        at(patch, "/api/scratchpad/settings", json!({"syncToNotes": "yes"})),
        at(patch, "/api/scratchpad/settings", json!({"syncToNotes": null})),
        at(patch, "/api/scratchpad/settings", json!({"syncToNotes": false})),
        at(patch, "/api/scratchpad/settings", json!({"syncToNotes": true})),
        at(patch, "/api/scratchpad/settings", json!(["x"])),
        at(patch, "/api/scratchpad/settings", json!("x")),
        json!({"method": "GET", "url": note}),
    ]
}

pub fn steps_with_a_notes_folder() -> Vec<Value> {
    let at = |m: &str, u: &str, b: Value| json!({"method": m, "url": u, "body": b});
    vec![
        json!({"method": "GET", "url": "/api/scratchpad"}),
        at("PATCH", "/api/scratchpad/settings", json!({"syncToNotes": true})),
        at("PATCH", "/api/scratchpad/settings", json!({"syncToNotes": true, "shortcut": "alt+k"})),
        json!({"method": "GET", "url": "/api/scratchpad"}),
        at("PATCH", "/api/scratchpad/settings", json!({"syncToNotes": false})),
    ]
}
