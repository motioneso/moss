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
        Value::Array(items) => items.iter_mut().for_each(mask),
        Value::Object(fields) => fields.values_mut().for_each(mask),
        _ => {}
    }
}

/// The old server's answers for one person's steps.
pub fn old_routes(actor: uuid::Uuid, steps: &[Value], vars: Value) -> Vec<Value> {
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/sports/tools/routes-oracle.ts"])
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
    parsed["responses"].as_array().unwrap().clone()
}

pub fn fill(text: &str, vars: &Value) -> String {
    let mut out = text.to_owned();
    for (name, value) in vars.as_object().unwrap() {
        out = out.replace(&format!("{{{name}}}"), value.as_str().unwrap());
    }
    out
}

fn get(url: &str) -> Value {
    json!({"method":"GET","url":url})
}
fn send(method: &str, url: &str, body: Value) -> Value {
    json!({"method":method,"url":url,"body":body})
}

/// Steps that need no ids. The old standings validation answers 500 by mistake, so those steps live elsewhere.
pub fn steps_before_ids() -> Vec<Value> {
    let long = "x".repeat(101);
    let follows = "/api/sports/follows";
    let prefs = "/api/sports/standings-preferences";
    vec![
        get(follows),
        get(prefs),
        send("POST", follows, json!({"competitionKey":"nfl"})),
        send("POST", follows, json!({"competitionKey":"nfl"})),
        send("POST", follows, json!({"competitionKey":"nba","extra":true})),
        send("POST", follows, json!({"competitionKey":"nope"})),
        send("POST", follows, json!({"competitionKey":5})),
        send("POST", follows, json!({"competitionKey":""})),
        send("POST", follows, json!({"competitionKey":long})),
        send("POST", follows, json!({"teamKey":"LAL"})),
        send("POST", follows, json!({"competitionKey":"nba","teamKey":long})),
        send("POST", follows, json!({"competitionKey":"nba","teamKey":"LAL"})),
        send("POST", follows, json!([])),
        get(follows),
        send("POST", &format!("{follows}/not-a-uuid/team"), json!({"sourceTeamId":"lal"})),
        send("POST", &format!("{follows}/99999999-9999-4999-8999-999999999999/team"), json!({"sourceTeamId":"lal"})),
        send("DELETE", &format!("{follows}/99999999-9999-4999-8999-999999999999"), Value::Null),
        send("DELETE", &format!("{follows}/not-a-uuid"), Value::Null),
        send("PUT", prefs, json!({"selectedCompetitionKeys":["nhl","nba"]})),
        get(prefs),
        send("PUT", prefs, json!({"selectedCompetitionKeys":[]})),
        send("PUT", prefs, json!({"lastViewed":{"competitionKey":"nhl"}})),
        send("PUT", prefs, json!({"lastViewed":{"competitionKey":"nhl","viewKey":"k","viewLabel":"L"}})),
        send("PUT", prefs, json!({"lastViewed":null})),
        get(prefs),
    ]
}

pub fn steps_with_ids() -> Vec<Value> {
    let follows = "/api/sports/follows";
    vec![
        send("POST", &format!("{follows}/{{whole}}/team"), json!({"teamKey":"LAL"})),
        send("POST", &format!("{follows}/{{whole}}/team"), json!({"sourceTeamId":"lal"})),
        send("POST", &format!("{follows}/{{whole}}/team"), json!({"sourceTeamId":""})),
        send("POST", &format!("{follows}/{{whole}}/team"), json!({"sourceTeamId":"x".repeat(101)})),
        send("DELETE", &format!("{follows}/{{whole}}"), Value::Null),
        send("DELETE", &format!("{follows}/{{whole}}"), Value::Null),
        get(follows),
    ]
}
