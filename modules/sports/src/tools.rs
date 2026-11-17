//! The Sports chat tools. The five followed-team tools live here and the nine source tools stay in
//! `source_tools`. Each tool calls the code its route calls.
use crate::teams::TeamList;
use crate::{briefing, follow_tools, heartbeat, results, source_tools};
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Map, Value};

pub const FACTS: &str = "sports.followedFactsToday";
pub const HEARTBEAT: &str = "sports.heartbeatNextFixtures";
pub const LATEST: &str = "sports.latestResult";

/// The tools handled here.
pub fn owns(tool: &str) -> bool {
    matches!(tool, FACTS | HEARTBEAT | LATEST | follow_tools::FOLLOW | follow_tools::UNFOLLOW)
}

fn failure(message: &str) -> Value {
    json!({"data":{"error":message}})
}

fn only(input: &Map<String, Value>, keys: &[&str]) -> bool {
    input.keys().all(|k| keys.contains(&k.as_str()))
}

fn latest<H: Host + ?Sized>(host: &H, input: &Map<String, Value>) -> Result<Value> {
    if !only(input, &["teamName", "competitionKey", "sourceTeamId"]) {
        return Ok(failure("Invalid Sports tool input"));
    }
    let query = input.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let request = RouteRequest { method: "GET".into(), path: "/results/latest".into(), params: Default::default(), query, body: Value::Null };
    let response: Response = results::latest(host, &request)?;
    if response.status >= 300 {
        return Ok(failure(response.body["error"].as_str().unwrap_or("The request failed")));
    }
    Ok(json!({"data":response.body}))
}

pub fn run<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, payload: &str) -> Result<Value> {
    let call: Value = serde_json::from_str(payload)?;
    let Some(tool) = call["tool"].as_str().filter(|t| owns(t)) else { return source_tools::run(host, teams, payload) };
    let Some(input) = call["parameters"].as_object() else { return Ok(failure("Invalid Sports tool input")) };
    match tool {
        FACTS => {
            if !only(input, &["timeZone"]) {
                return Ok(failure("Invalid Sports tool input"));
            }
            Ok(json!({"data":briefing::today(host, input.get("timeZone").and_then(Value::as_str).unwrap_or("UTC"))}))
        }
        HEARTBEAT => match heartbeat::read_input(&call["parameters"]) {
            Some((hours, limit)) => Ok(json!({"data":heartbeat::run(host, hours, limit)?})),
            None => Ok(failure("Invalid Sports tool input")),
        },
        LATEST => latest(host, input),
        _ => {
            // A change runs only against the card the person approved.
            let current = follow_tools::card(host, teams, tool, &call["parameters"])?;
            let shown = current.as_ref().and_then(|card| card["version"].as_str());
            if shown.is_none() || shown != call["approvalVersion"].as_str() {
                return Ok(failure("The approval no longer matches this follow. Ask again to review the current details."));
            }
            if tool == follow_tools::FOLLOW {
                follow_tools::follow(host, teams, input)
            } else {
                follow_tools::unfollow(host, teams, input)
            }
        }
    }
}
