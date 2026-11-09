//! Narrow data parity oracle. This is not the full Calendar HTTP/UI parity gate.
use moss_calendar::{events, heartbeat, model};
use serde_json::{json, Value};
use std::io::{self, Read};
fn run(v: &Value) -> moss_calendar::Result<Value> {
    match v["op"].as_str().unwrap_or("") {
        "assistant-name" => Ok(json!(model::assistant_name(&v["value"]["assistantName"]))),
        "event" => Ok(events::serialize(&v["value"])),
        "heartbeat-input" => {
            let (horizon_hours, limit) = heartbeat::parse(&v["value"])?;
            Ok(json!({"horizonHours":horizon_hours,"limit":limit}))
        }
        "heartbeat-revision" => {
            let parts: Vec<String> = serde_json::from_value(v["value"].clone())?;
            Ok(json!(heartbeat::revision(&parts)))
        }
        "intent" => model::merge_intent(&v["current"], v.get("patch")),
        "day" => {
            let (day, zone) = model::day_zone(
                v["day"].as_str().unwrap_or(""),
                v["zone"].as_str().unwrap_or(""),
            )?;
            Ok(json!([day, zone]))
        }
        "block" => {
            let b = model::block(&v["value"], 0)?;
            Ok(
                json!({"kind":b["kind"],"title":b["title"],"taskId":b["task_id"],"pendingChange":b["pending_change"]}),
            )
        }
        _ => Err(model::invalid("Unknown parity operation")),
    }
}
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap();
    let results: Vec<Value> = cases
        .iter()
        .map(|v| match run(v) {
            Ok(data) => json!({"ok":data}),
            Err(_) => json!({"error":true}),
        })
        .collect();
    println!("{}", serde_json::to_string(&results).unwrap());
}
