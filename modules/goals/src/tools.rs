//! Legacy tool replies, with mutations shared with the HTTP routes. The trusted host runs
//! these handlers only after applying the person's approval policy.
use crate::{goals, util};
use moss_module_sdk::{
    query::{Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub tool: String,
    pub parameters: Value,
}

pub(crate) fn request(method: &str, path: &str, input: &Value) -> RouteRequest {
    RouteRequest {
        method: method.into(),
        path: path.into(),
        params: input["goalId"]
            .as_str()
            .map(|id| ("id".into(), id.into()))
            .into_iter()
            .collect(),
        query: Default::default(),
        body: input.clone(),
    }
}

pub(crate) fn valid(tool: &str, input: &Value) -> bool {
    let Some(map) = input.as_object() else {
        return false;
    };
    let (allowed, required): (&[&str], &[&str]) = match tool {
        "goals.list" => (&[], &[]),
        "goals.get" => (&["goalId"], &["goalId"]),
        "goals.create" => (
            &[
                "title",
                "desiredOutcome",
                "priority",
                "reviewCadence",
                "targetAt",
            ],
            &["title", "desiredOutcome"],
        ),
        "goals.update" => (
            &[
                "goalId",
                "title",
                "desiredOutcome",
                "status",
                "priority",
                "reviewCadence",
                "targetAt",
            ],
            &["goalId"],
        ),
        "goals.addEvidence" => (
            &[
                "goalId",
                "evidenceKind",
                "sourceKind",
                "sourceRef",
                "sourceLabel",
                "summary",
                "occurredAt",
            ],
            &[
                "goalId",
                "evidenceKind",
                "sourceKind",
                "sourceLabel",
                "summary",
            ],
        ),
        _ => return false,
    };
    required.iter().all(|k| map.contains_key(*k))
        && map.iter().all(|(k, v)| {
            allowed.contains(&k.as_str())
                && if k == "priority" {
                    v.as_i64().is_some_and(|n| (1..=5).contains(&n))
                } else {
                    v.is_string()
                }
        })
}

pub fn handle<H: Host + ?Sized>(host: &H, req: Request) -> Result<Value> {
    if !valid(&req.tool, &req.parameters) {
        return Ok(json!({"data":{"error":"Invalid Goals tool input"}}));
    }
    let input = &req.parameters;
    let before = if req.tool == "goals.update" {
        crate::chat::before(host, input)?
    } else {
        Value::Null
    };
    let response = match req.tool.as_str() {
        "goals.list" => return Ok(json!({"data":{"items":goals::list(host)?.body}})),
        "goals.get" => {
            let goal = goals::get(host, &request("GET", "/goals/:id", input))?;
            if goal.status != 200 {
                return Ok(json!({"data":goal.body}));
            }
            let mut query = Query::select(Filter::eq("goal_id", input["goalId"].as_str().unwrap()));
            query.order = vec![Order {
                column: "created_at".into(),
                descending: true,
            }];
            query.limit = Some(10);
            let evidence: Vec<_> = Client(host).query(goals::EVIDENCE, &query)?.iter().map(|e| {
                json!({"evidenceKind":e["evidence_kind"],"summary":e["summary"],"sourceLabel":e["source_label"]})
            }).collect();
            return Ok(json!({"data":{"goal":goal.body,"evidence":evidence}}));
        }
        "goals.create" => goals::create(host, &request("POST", "/goals", input))?,
        "goals.update" => goals::change(host, &request("PATCH", "/goals/:id", input))?,
        "goals.addEvidence" => {
            goals::add_evidence(host, &request("POST", "/goals/:id/evidence", input))?
        }
        _ => return Err(Error::new("Unknown Goals tool")),
    };
    let mut data = response.body;
    if response.status < 400 {
        let changed = crate::chat::completed(input, &before, &data);
        data["changed"] = json!(changed);
    }
    Ok(json!({"data":data}))
}

/// Signed-in transport for chat hosts. This crosses the host's one-use, exact-input approval
/// boundary; it must never call `handle` directly or accept an approval flag from the caller.
pub fn run<H: Host + ?Sized>(host: &H, body: &Value) -> Result<Response> {
    let req: Request = match serde_json::from_value(body.clone()) {
        Ok(req) => req,
        Err(_) => return Ok(util::bad_request("Invalid Goals tool request")),
    };
    if !valid(&req.tool, &req.parameters) {
        return Ok(util::bad_request("Invalid Goals tool input"));
    }
    match host.call(
        "tools",
        "run",
        &req.tool,
        json!({"parameters":req.parameters}),
    ) {
        Ok(result) => Ok(Response::new(200, result)),
        Err(_) => Ok(util::error(
            403,
            "Goal tool unavailable or approval required",
        )),
    }
}

/// Today uses the same priority-ordered list as the old section, showing active goals only.
pub fn today<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let list = goals::list(host)?;
    let active: Vec<_> = list
        .body
        .as_array()
        .ok_or_else(|| Error::new("Invalid Goals list"))?
        .iter()
        .filter(|g| g["status"] == "active")
        .cloned()
        .collect();
    Ok(Response::new(200, json!(active)))
}
