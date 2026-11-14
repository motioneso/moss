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
        .args(["exec", "tsx", "modules/news/tools/routes-oracle.ts"])
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

const PREFS: &str = "/api/news/prefs";
const PERSONALIZATION: &str = "/api/news/personalization";
const EXCLUSIONS: &str = "/api/news/source-exclusions";
const TOPICS: &str = "/api/news/topics";
const SOURCES: &str = "/api/news/sources";
const MISSING: &str = "99999999-9999-4999-8999-999999999999";

/// Steps that need no ids.
pub fn steps_before_ids() -> Vec<Value> {
    let long = "x".repeat(101);
    let mut steps = vec![
        get("/api/news/catalog"),
        get(PREFS),
        get(PERSONALIZATION),
        send("POST", PREFS, json!({"kind":"source","key":"bbc"})),
        send("POST", PREFS, json!({"kind":"source","key":"bbc"})),
        send("POST", PREFS, json!({"kind":"topic","key":"science"})),
        send("POST", PREFS, json!({"kind":"source_exclude","key":"verge"})),
        send("POST", PREFS, json!({"kind":"source","key":"nope"})),
        send("POST", PREFS, json!({"kind":"topic","key":"nope"})),
        send("POST", PREFS, json!({"kind":"source_exclude","key":"nope"})),
        send("POST", PREFS, json!({"kind":"other","key":"bbc"})),
        send("POST", PREFS, json!({"kind":"source"})),
        send("POST", PREFS, json!({"key":"bbc"})),
        send("POST", PREFS, json!({"kind":"source","key":""})),
        send("POST", PREFS, json!({"kind":"source","key":long})),
        send("POST", PREFS, json!({"kind":"source","key":5})),
        send("POST", PREFS, json!({"kind":"source","key":"bbc","extra":true})),
        send("POST", PREFS, json!([])),
        get(PREFS),
        send("DELETE", &format!("{PREFS}/not-a-uuid"), Value::Null),
        send("DELETE", &format!("{PREFS}/{MISSING}"), Value::Null),
        send("POST", EXCLUSIONS, json!({"source":"https://Www.Example.com/news?x=1"})),
        send("POST", EXCLUSIONS, json!({"source":"www.example.com"})),
        send("POST", EXCLUSIONS, json!({"source":"example.org."})),
        send("POST", EXCLUSIONS, json!({"source":"http://example.com"})),
        send("POST", EXCLUSIONS, json!({"source":"https://u:p@example.com"})),
        send("POST", EXCLUSIONS, json!({"source":"https://example.com:8443"})),
        send("POST", EXCLUSIONS, json!({"source":"https://10.0.0.1"})),
        send("POST", EXCLUSIONS, json!({"source":"localhost"})),
        send("POST", EXCLUSIONS, json!({"source":"bad_label.example"})),
        send("POST", EXCLUSIONS, json!({"source":"bücher.de"})),
        send("POST", EXCLUSIONS, json!({"source":"https://BÜCHER.de/x"})),
        send("POST", EXCLUSIONS, json!({"source":"日本語.jp"})),
        send("POST", EXCLUSIONS, json!({"source":"https://"})),
        send("POST", EXCLUSIONS, json!({"source":"ftp://example.com"})),
        send("POST", EXCLUSIONS, json!({"source":""})),
        send("POST", EXCLUSIONS, json!({"source":"  "})),
        send("POST", EXCLUSIONS, json!({"source":"x".repeat(2049)})),
        send("POST", EXCLUSIONS, json!({})),
        send("POST", EXCLUSIONS, json!({"source":7})),
        send("DELETE", &format!("{EXCLUSIONS}/not-a-uuid"), Value::Null),
        send("DELETE", &format!("{EXCLUSIONS}/{MISSING}"), Value::Null),
        send("POST", TOPICS, json!({"label":"Space"})),
        send("POST", TOPICS, json!({"label":"  "})),
        send("POST", TOPICS, json!({"label":""})),
        send("POST", TOPICS, json!({})),
        send("POST", TOPICS, json!({"label":"x".repeat(81)})),
        send("POST", TOPICS, json!({"label":"Space","guidance":"y".repeat(1001)})),
        send("PATCH", &format!("{TOPICS}/{MISSING}"), json!({"label":"Space"})),
        send("PATCH", &format!("{TOPICS}/{MISSING}"), json!({})),
        send("PATCH", &format!("{TOPICS}/{MISSING}"), json!({"foo":1})),
        send("PATCH", &format!("{TOPICS}/not-a-uuid"), json!({"label":"Space"})),
        send("DELETE", &format!("{TOPICS}/not-a-uuid"), Value::Null),
        send("DELETE", &format!("{TOPICS}/{MISSING}"), Value::Null),
        send("DELETE", &format!("{SOURCES}/not-a-uuid"), Value::Null),
        send("DELETE", &format!("{SOURCES}/{MISSING}"), Value::Null),
        get(PREFS),
        get(PERSONALIZATION),
    ];
    // The limit: 100 exclusions, then one more, then a repeat.
    for n in 0..100 {
        steps.push(send("POST", EXCLUSIONS, json!({"source":format!("site{n}.example")})));
    }
    steps.push(send("POST", EXCLUSIONS, json!({"source":"site0.example"})));
    steps
}

/// Steps that name rows the test planted or the earlier steps made. `{pref}` and `{excl}` come
/// from the earlier answers, `{src}`, `{src2}` and `{topic}` from the planted rows.
pub fn steps_with_ids() -> Vec<Value> {
    vec![
        get(PERSONALIZATION),
        send("PATCH", &format!("{TOPICS}/{{topic}}"), json!({"label":"Stars"})),
        send("PATCH", &format!("{TOPICS}/{{topic}}"), json!({"label":"  "})),
        send("PATCH", &format!("{TOPICS}/{{topic}}"), json!({})),
        send("DELETE", &format!("{SOURCES}/{{src}}"), Value::Null),
        get(PERSONALIZATION),
        send("DELETE", &format!("{SOURCES}/{{src}}"), Value::Null),
        send("POST", EXCLUSIONS, json!({"source":"https://news.example.net/a"})),
        get(PERSONALIZATION),
        send("DELETE", &format!("{TOPICS}/{{topic}}"), Value::Null),
        send("DELETE", &format!("{TOPICS}/{{topic}}"), Value::Null),
        send("DELETE", &format!("{PREFS}/{{pref}}"), Value::Null),
        send("DELETE", &format!("{PREFS}/{{pref}}"), Value::Null),
        send("DELETE", &format!("{EXCLUSIONS}/{{excl}}"), Value::Null),
        send("DELETE", &format!("{EXCLUSIONS}/{{excl}}"), Value::Null),
        get(PREFS),
        get(PERSONALIZATION),
    ]
}

/// Adding a source, up to and including the preview that succeeds. The last step must be that preview.
pub fn steps_adding_before_save() -> Vec<Value> {
    let long = "x".repeat(513);
    vec![
        send("POST", &format!("{SOURCES}/preview"), json!({})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":long})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"daily.sample.test","replaceSourceId":"nope"})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"daily.sample.test","extra":1})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"r/a"})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"http://daily.sample.test"})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"https://10.0.0.1"})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"a newspaper with a name"})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"https://down.sample.test/"})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"https://example.com/"})),
        send("POST", SOURCES, json!({})),
        send("POST", SOURCES, json!({"confirmationId":MISSING})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"https://daily.sample.test/"})),
    ]
}

/// Saving what the last preview showed. `{conf}` is that preview's confirmation id.
pub fn steps_adding_save() -> Vec<Value> {
    vec![
        send("POST", SOURCES, json!({"confirmationId":"{conf}"})),
        send("POST", SOURCES, json!({"confirmationId":"{conf}"})),
        send("POST", &format!("{SOURCES}/preview"), json!({"input":"daily.sample.test"})),
        get(PERSONALIZATION),
    ]
}
