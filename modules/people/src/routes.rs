//! Legacy People data routes through the shared authenticated route envelope.
//! Ingest publication and installed HTTP composition remain separate joins.
use crate::{
    note_edits::{CreateNote, UpdateNote},
    notes_format::NoteStatus,
    notes_service::NotesService,
    repository::Repository,
};
use moss_module_sdk::{Error, Host, Response, Result, RouteRequest};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Merge {
    secondary_person_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Split {
    identity_id: String,
    target_person_id: Option<String>,
    new_person_display_name: Option<String>,
}

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let request: RouteRequest = serde_json::from_str(payload)?;
    // The same safe 5xx body as the current central HTTP error handler. A failed
    // response makes the shared host roll back/compensate the invocation.
    let response = execute(host, &request)
        .unwrap_or_else(|_| Response::new(500, json!({"error":"Internal Server Error"})));
    Ok(serde_json::to_string(&response)?)
}

fn execute(host: &impl Host, request: &RouteRequest) -> Result<Response> {
    if let Some(response) = crate::settings::route(host, request)? {
        return Ok(response);
    }
    let repo = Repository::new(host);
    let notes = NotesService::new(host);
    let id = || {
        request
            .params
            .get("id")
            .map(String::as_str)
            .ok_or_else(|| Error::new("Missing person ID"))
    };
    let query = |name: &str| request.query.get(name).and_then(Value::as_str);
    let limit = || parse_limit(request.query.get("limit"));
    let value = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/people") => {
            json!({"people":repo.list_people(query("status"),query("search"),limit()?)?})
        }
        ("GET", "/people/resolve") => {
            json!({"person":repo.resolve(query("q").ok_or_else(||Error::new("Missing query"))?)?})
        }
        ("GET", "/people/match-candidates") => json!({"candidates":repo.candidates(None)?}),
        ("GET", "/people/:id") => json!({"person":repo.detail(id()?)?}),
        ("GET", "/people/:id/links") => {
            json!({"links":repo.links(id()?,query("sourceKind"),query("linkKind"),limit()?)?})
        }
        ("POST", "/people/match-candidates/:id/accept") => {
            repo.accept_candidate(id()?)?;
            json!({"accepted":true})
        }
        ("POST", "/people/match-candidates/:id/reject") => {
            repo.reject_candidate(id()?)?;
            json!({"rejected":true})
        }
        ("POST", "/people/match-candidates/:id/suppress") => {
            repo.suppress_candidate(id()?)?;
            json!({"suppressed":true})
        }
        ("POST", "/people/:id/merge") => {
            let args: Merge = serde_json::from_value(request.body.clone())?;
            json!({"person":repo.merge(id()?,&args.secondary_person_id)?})
        }
        ("POST", "/people/:id/split-identity") => {
            let args: Split = serde_json::from_value(request.body.clone())?;
            json!({"person":repo.split_identity(&args.identity_id,args.target_person_id.as_deref(),args.new_person_display_name.as_deref())?})
        }
        ("POST", "/people") => {
            notes.create(&serde_json::from_value::<CreateNote>(request.body.clone())?)?
        }
        ("POST", "/people/notes/refresh") => match notes.refresh_for_route()? {
            Some(value) => value,
            None => {
                return Ok(Response::new(
                    400,
                    json!({"error":"People notes folder is unavailable"}),
                ))
            }
        },
        ("PATCH", "/people/:id") => {
            let patch: UpdateNote = serde_json::from_value(request.body.clone())?;
            match notes.update_for_route(id()?, &patch)? {
                Some(result) => result,
                None => json!({"person":repo.update_projection(id()?, &request.body)?}),
            }
        }
        ("POST", "/people/:id/archive") => {
            let patch = UpdateNote {
                status: Some(NoteStatus::Archived),
                ..UpdateNote::default()
            };
            match notes.update_for_route(id()?, &patch)? {
                Some(mut result) => {
                    result["archived"] = json!(true);
                    result
                }
                None => {
                    repo.update_projection(id()?, &json!({"status":"archived"}))?;
                    json!({"archived":true})
                }
            }
        }
        _ => return Ok(Response::new(404, json!({"error":"Not Found"}))),
    };
    Ok(Response::new(200, value))
}

// Legacy parseInt accepts numeric prefixes; zero/NaN mean no limit. Negative
// and overflowing limits fail safely instead of wrapping into another count.
fn parse_limit(value: Option<&Value>) -> Result<Option<u32>> {
    let text = match value {
        None => return Ok(None),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| v.as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(","),
        _ => return Err(Error::new("Invalid People limit")),
    };
    let text = text.trim_start_matches(crate::js_space);
    let (negative, digits) = if let Some(rest) = text.strip_prefix('-') {
        (true, rest)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return Ok(None);
    }
    let count: u32 = digits
        .parse()
        .map_err(|_| Error::new("Invalid People limit"))?;
    if negative && count != 0 {
        return Err(Error::new("Invalid People limit"));
    }
    Ok((count != 0).then_some(count))
}
