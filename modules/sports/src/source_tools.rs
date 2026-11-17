//! The nine source chat tools. Each one calls the same code as its route, so a tool and a route
//! cannot disagree. The host asks the person before any tool that is not a read. A change tool
//! also carries the version of the card the person approved, and runs only if the card built now
//! still has that version.
use crate::source_approval;
use crate::source_routes as routes;
use crate::sources;
use crate::teams::TeamList;
use crate::util::is_uuid;
use crate::source_rebuild;
use moss_module_sdk::{Host, Response, Result, RouteRequest};
use serde_json::{json, Value};

const CONFIRM: [&str; 5] = ["confirmationId", "authorizationAcknowledgement", "canonicalDomain", "confirmedFetchHosts", "targets"];

/// The keys a tool accepts. Any other key is refused, as the old tool schemas did.
fn allowed(tool: &str) -> Option<Vec<&'static str>> {
    Some(match tool {
        "sports.listSources" => vec![],
        "sports.previewSource" => vec!["url", "assignments"],
        "sports.previewSourceAssignments" => vec!["sourceId", "assignments"],
        "sports.rebuildSourceRecipe" | "sports.retrySource" | "sports.removeSource" => vec!["sourceId"],
        "sports.confirmSource" => CONFIRM.to_vec(),
        "sports.confirmSourceAssignments" | "sports.confirmSourceRecipe" => {
            let mut keys = vec!["sourceId"];
            keys.extend(CONFIRM);
            keys
        }
        _ => return None,
    })
}

fn failure(message: &str) -> Value {
    json!({"data":{"error":message}})
}

/// A route answer as a tool answer. Refusals keep their message.
fn reply(response: Response) -> Value {
    if response.status >= 300 {
        return failure(response.body["error"].as_str().unwrap_or("The request failed"));
    }
    json!({"data":response.body})
}

fn request(method: &str, path: &str, source: Option<&str>, body: Value) -> RouteRequest {
    RouteRequest {
        method: method.into(),
        path: path.into(),
        params: source.map(|id| [("id".to_owned(), id.to_owned())].into()).unwrap_or_default(),
        query: Default::default(),
        body,
    }
}

pub fn run<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, payload: &str) -> Result<Value> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Call {
        tool: String,
        parameters: Value,
        approval_version: Option<String>,
    }
    let call: Call = serde_json::from_str(payload)?;
    let tool = call.tool.as_str();
    let Some(keys) = allowed(tool) else { return Ok(failure("Unknown Sports tool")) };
    let Some(input) = call.parameters.as_object() else { return Ok(failure("Invalid Sports tool input")) };
    if input.keys().any(|key| !keys.contains(&key.as_str())) {
        return Ok(failure("Invalid Sports tool input"));
    }
    let source = match input.get("sourceId") {
        None => None,
        Some(Value::String(id)) if is_uuid(id) => Some(id.clone()),
        Some(_) => return Ok(failure("sourceId must match format \"uuid\"")),
    };
    if keys.contains(&"sourceId") && source.is_none() {
        return Ok(failure("Provide the sourceId to use."));
    }
    // A change runs only against the card the person approved.
    if source_approval::action(tool).is_some() {
        let current = source_approval::card(host, teams, tool, &call.parameters)?;
        let approved = current.as_ref().and_then(|card| card["version"].as_str());
        if approved.is_none() || approved != call.approval_version.as_deref() {
            return Ok(failure("The approval no longer matches this source. Ask again to review the current details."));
        }
    }
    let body = || {
        let mut rest = input.clone();
        rest.remove("sourceId");
        Value::Object(rest)
    };
    let id = source.as_deref();
    Ok(match tool {
        "sports.listSources" => reply(routes::list(host)?),
        "sports.previewSource" => reply(routes::preview_new(host, teams, &request("POST", "/sources/preview", None, body()))?),
        "sports.previewSourceAssignments" => {
            reply(routes::preview_assignments(host, teams, &request("POST", "/sources/:id/assignments/preview", id, body()))?)
        }
        "sports.rebuildSourceRecipe" => reply(source_rebuild::preview(host, teams, &request("POST", "/sources/:id/rebuild/preview", id, json!({})))?),
        "sports.confirmSource" => reply(routes::confirm_new(host, &request("POST", "/sources", None, body()))?),
        "sports.confirmSourceAssignments" => {
            reply(routes::confirm_assignments(host, &request("PATCH", "/sources/:id/assignments", id, body()))?)
        }
        "sports.confirmSourceRecipe" => reply(source_rebuild::confirm(host, &request("PATCH", "/sources/:id/rebuild", id, body()))?),
        "sports.retrySource" => reply(source_rebuild::retry(host, &request("POST", "/sources/:id/retry", id, json!({})))?),
        _ => {
            let id = id.unwrap_or_default();
            if sources::find(host, id)?.is_none() {
                return Ok(failure("That sports source was not found."));
            }
            json!({"data":{"removed":sources::remove(host, id)?}})
        }
    })
}
