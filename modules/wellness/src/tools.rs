//! The two assistant tools. Both answer only while the person allows assistant access. With it
//! off they read no row and hand back the fixed refusal. The trusted host runs these handlers only
//! after applying the person's approval policy.
use crate::{adherence, checkins, consent, insights, util};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Host, Response, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

const RECENT: u32 = 20;
const COLUMNS: [&str; 6] = ["checkedInAt", "feelingCore", "feelingSecondary", "intensity", "moodIndex", "note"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub tool: String,
    pub parameters: Value,
}

/// Both tools take no input. Anything else is refused.
fn valid(tool: &str, input: &Value) -> bool {
    matches!(tool, "wellness.recentCheckIns" | "wellness.medicationAdherence")
        && input.as_object().is_some_and(|map| map.is_empty())
}

fn recent<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let mut query = Query::select(Filter::All);
    query.order = vec![Order { column: "checked_in_at".into(), descending: true }];
    query.limit = Some(RECENT);
    let items: Vec<Value> = Client(host)
        .query(checkins::CHECKINS, &query)?
        .iter()
        .map(|row| {
            let dto = checkins::dto(row)?;
            let mood = match dto["intensity"].as_f64() {
                Some(intensity) => json!(insights::mood_index(dto["feelingCore"].as_str().unwrap_or_default(), intensity)),
                None => Value::Null,
            };
            Ok(json!({
                "checkedInAt": dto["checkedInAt"],
                "feelingCore": dto["feelingCore"],
                "feelingSecondary": dto["feelingSecondary"],
                "intensity": dto["intensity"],
                "moodIndex": mood,
                "note": dto["note"],
            }))
        })
        .collect::<Result<_>>()?;
    Ok(json!({"data": {"items": items}, "columnOrder": COLUMNS}))
}

/// Check the choice first, so a refused call reads nothing.
pub fn handle<H: Host + ?Sized>(host: &H, req: Request) -> Result<Value> {
    if !valid(&req.tool, &req.parameters) {
        return Ok(json!({"data": {"error": "Invalid Wellness tool input"}}));
    }
    if !consent::effective(host)? {
        return Ok(consent::refused());
    }
    match req.tool.as_str() {
        "wellness.recentCheckIns" => recent(host),
        _ => Ok(json!({"data": adherence::counts(host)?})),
    }
}

/// Signed-in transport for chat hosts. This crosses the host's approval boundary and must never
/// call `handle` directly or accept an approval flag from the caller.
pub fn run<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response> {
    let req: Request = match serde_json::from_value(body.clone()) {
        Ok(req) => req,
        Err(_) => return Ok(util::bad_request("Invalid Wellness tool request")),
    };
    if !valid(&req.tool, &req.parameters) {
        return Ok(util::bad_request("Invalid Wellness tool input"));
    }
    match host.call("tools", "run", &req.tool, json!({"parameters": req.parameters})) {
        Ok(result) => Ok(Response::new(200, result)),
        Err(_) => Ok(util::error(403, "Wellness tool unavailable or approval required")),
    }
}
