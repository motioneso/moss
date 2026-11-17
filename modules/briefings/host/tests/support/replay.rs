//! Replays the old routes against the installed package, step for step.
use serde_json::{json, Value};
use std::{io::Write, process::{Command, Stdio}};

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
        Value::Number(number) => *number = serde_json::Number::from_f64(number.as_f64().unwrap()).unwrap(),
        Value::Array(items) => items.iter_mut().for_each(mask),
        Value::Object(fields) => fields.values_mut().for_each(mask),
        _ => {}
    }
}

/// The old server's answers for one person's steps, plus the schedule calls it made.
pub fn old_routes(actor: uuid::Uuid, steps: &[Value], vars: Value) -> (Vec<Value>, Vec<Value>) {
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/briefings/tools/routes-oracle.ts"])
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
        .write_all(json!({"actor":actor,"steps":steps,"vars":vars}).to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "Old route oracle failed: {}", String::from_utf8_lossy(&out.stderr));
    let parsed: Value = serde_json::from_slice(&out.stdout).unwrap();
    (
        parsed["responses"].as_array().unwrap().clone(),
        parsed["calls"].as_array().unwrap().clone(),
    )
}

pub fn fill(text: &str, vars: &Value) -> String {
    let mut out = text.to_owned();
    for (name, value) in vars.as_object().unwrap() {
        out = out.replace(&format!("{{{name}}}"), value.as_str().unwrap());
    }
    out
}

pub fn steps_before_ids() -> Vec<Value> {
    let big = "x".repeat(300);
    vec![
        json!({"method":"GET","url":"/api/briefings/definitions"}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"Morning plan","briefingType":"morning","cadence":"daily"}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"Weekly look","briefingType":"weekly_review","cadence":"weekly","scheduleMetadata":{"targetTime":"09:30","dayOfWeek":3}}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"Evening","briefingType":"evening"}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"   "}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"x","cadence":"hourly"}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"x","briefingType":"noon"}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"x","selectedToolNames":["nonexistent_tool"]}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"x","selectedToolNames":[""]}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"x","scheduleMetadata":{"timezone":"Not/AZone"}}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":"x","cadence":"weekly","scheduleMetadata":{"targetTime":"07:00"}}}),
        json!({"method":"POST","url":"/api/briefings/definitions","body":{"title":big}}),
        json!({"method":"GET","url":"/api/briefings/definitions"}),
        json!({"method":"PATCH","url":"/api/briefings/definitions/99999999-9999-4999-8999-999999999999","body":{"title":"x"}}),
        json!({"method":"GET","url":"/api/briefings/definitions/99999999-9999-4999-8999-999999999999/runs"}),
        json!({"method":"GET","url":"/api/briefings/definitions/99999999-9999-4999-8999-999999999999/runs/99999999-9999-4999-8999-999999999998"}),
    ]
}

pub fn steps_with_ids() -> Vec<Value> {
    vec![
        json!({"method":"PATCH","url":"/api/briefings/definitions/{def}","body":{"title":"Renamed"}}),
        json!({"method":"PATCH","url":"/api/briefings/definitions/{def}","body":{"cadence":"manual"}}),
        json!({"method":"PATCH","url":"/api/briefings/definitions/{def}","body":{"enabled":false}}),
        json!({"method":"PATCH","url":"/api/briefings/definitions/{def}","body":{"enabled":true,"cadence":"daily","scheduleMetadata":{"targetTime":"06:15"}}}),
        json!({"method":"PATCH","url":"/api/briefings/definitions/{def}","body":{"title":""}}),
        json!({"method":"PATCH","url":"/api/briefings/definitions/{def}","body":{"scheduleMetadata":{"timezone":"Not/AZone"}}}),
        json!({"method":"GET","url":"/api/briefings/definitions"}),
        json!({"method":"GET","url":"/api/briefings/definitions/{def}/runs"}),
        json!({"method":"GET","url":"/api/briefings/definitions/{def}/runs/{run}"}),
        json!({"method":"GET","url":"/api/briefings/definitions/{def}/runs/99999999-9999-4999-8999-999999999998"}),
    ]
}
