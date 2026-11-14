//! Connectors guest. It validates requests, shapes responses and applies the grant and
//! health rules. Sealing secrets, SQL and the acting person all belong to the host.
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
mod abi;
pub mod accounts;
pub mod calendar_context;
pub mod calendar_writes;
pub mod email_context;
pub mod email_writes;
pub mod live_tools;
pub mod monitors;
pub mod outlook;
pub mod outlook_availability;
pub mod outlook_scan;
pub mod outlook_source;
pub mod fastify;
pub mod google;
pub mod google_sync;
pub mod imap;
pub mod grants;
pub mod health;
pub mod mail_sync;
pub mod refresh;
#[cfg(not(target_arch = "wasm32"))]
pub mod testing;

#[derive(Debug)]
pub struct Error {
    pub status: u16,
    pub message: String,
}
impl Error {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}
impl From<moss_module_sdk::Error> for Error {
    fn from(_: moss_module_sdk::Error) -> Self {
        Self::new(500, "Internal server error")
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn kv(host: &impl Host, operation: &str, resource: &str, params: Value) -> Result<Value> {
    Ok(host.call("kv", operation, resource, params)?)
}

pub fn handle(host: &impl Host, kind: &str, payload: &str) -> std::result::Result<String, String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "api" => {
            let input: Value =
                serde_json::from_str(payload).map_err(|_| "Invalid connectors request")?;
            let data = api(host, input["name"].as_str().unwrap_or(""), &input["parameters"])
                .map_err(|e| e.message)?;
            serde_json::to_string(&data).map_err(|_| "Invalid connectors response".into())
        }
        "route" => {
            let response = match serde_json::from_str::<RouteRequest>(payload) {
                Ok(request) => match route(host, request) {
                    Ok((status, body)) => Response::new(status, body),
                    Err(error) => Response::new(error.status, json!({"error":error.message})),
                },
                Err(_) => Response::new(400, json!({"error":"Invalid connectors request"})),
            };
            serde_json::to_string(&response).map_err(|_| "Invalid connectors response".into())
        }
        "job" => {
            let queue = serde_json::from_str::<Value>(payload).ok().and_then(|j| j["queue"].as_str().map(String::from));
            match queue.as_deref() {
                Some(google_sync::QUEUE | google_sync::SWEEP | google_sync::REFRESH_QUEUE) => {
                    google_sync::handle(host, payload)
                }
                Some(monitors::EMAIL_QUEUE | monitors::CALENDAR_QUEUE) => monitors::handle(host, payload),
                Some(refresh::SWEEP) => refresh::handle(host, payload),
                Some(outlook::QUEUE) => outlook::handle(host, payload),
                _ => mail_sync::handle(host, payload),
            }
        }
        "tool" => {
            let input: Value =
                serde_json::from_str(payload).map_err(|_| "Invalid connectors request")?;
            match input["tool"].as_str() {
                Some("connectors.startGoogleGuidance") | Some("startGoogleGuidance") => {
                    serde_json::to_string(&google::guidance())
                        .map_err(|_| "Invalid connectors response".into())
                }
                Some("email.listVisibleMessages") => {
                    live(email_context::list(host, &input["parameters"]).map(|v| json!({"data":v})))
                }
                Some("gmail.searchLive") => live(live_tools::search(host, &input["parameters"])),
                Some("gmail.getLiveMessage") => live(live_tools::message(host, &input["parameters"])),
                Some("calendar.listLiveEvents") => live(live_tools::events(host, &input["parameters"])),
                Some(name @ ("email.draftReply" | "email.sendReply")) => live(email_writes::run(
                    host,
                    name == "email.sendReply",
                    &input["parameters"],
                    input["approvalVersion"].as_str(),
                )),
                _ => Err("Connectors tool is unavailable".into()),
            }
        }
        _ => Err("Connectors handler is unavailable".into()),
    }
}

fn live(result: Result<Value>) -> std::result::Result<String, String> {
    let value = result.map_err(|e| e.message)?;
    serde_json::to_string(&value).map_err(|_| "Invalid connectors response".into())
}

fn api(host: &impl Host, name: &str, input: &Value) -> Result<Value> {
    match name {
        "listCalendarContext" => calendar_context::list(host, input),
        "listEmailContext" => email_context::list(host, input),
        "listSavedEmailContext" => email_context::list_saved(host, input["connectorAccountId"].as_str().unwrap_or("")),
        "prepareEmailAction" => email_writes::prepare(host, input),
        "createCalendarEvent" => calendar_writes::create(host, input),
        "deleteCalendarEvent" => calendar_writes::delete(host, input),
        "rescheduleCalendarEvent" => calendar_writes::reschedule(host, input),
        "connectionDiagnostics" => accounts::diagnostics(host, input["limit"].as_i64().unwrap_or(10)),
        _ => Err(Error::new(404, "Connectors operation not found")),
    }
}

fn route(host: &impl Host, request: RouteRequest) -> Result<(u16, Value)> {
    let id = request.params.get("id").cloned().unwrap_or_default();
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/providers") => accounts::providers(host).map(|b| (200, b)),
        ("GET", "/accounts") => accounts::list(host).map(|b| (200, b)),
        ("POST", "/accounts") => accounts::create(host, &request.body).map(|b| (201, b)),
        ("PATCH", "/accounts/:id") => accounts::update(host, &id, &request.body).map(|b| (200, b)),
        ("POST", "/accounts/:id/revoke") => accounts::revoke(host, &id).map(|b| (200, b)),
        ("GET", "/accounts/:id/feature-grants") => accounts::grants(host, &id).map(|b| (200, b)),
        ("PUT", "/accounts/:id/feature-grants") => {
            accounts::put_grants(host, &id, &request.body).map(|b| (200, b))
        }
        ("POST", "/google/authorize") => google::authorize(host, &request.body).map(|b| (200, b)),
        ("POST", "/google/sync") => google_sync::sync_route(host, &request.body),
        ("POST", "/google/complete") => google::complete(host, &request.body),
        ("POST", "/imap/test-connection") => imap::test_connection(host, &request.body).map(|b| (200, b)),
        ("POST", "/imap/connect") => imap::connect(host, &request.body),
        ("POST", "/email-refresh") => refresh::request(host, &request.body),
        ("GET", "/email-refresh/:refresh_id") => {
            let id = request.params.get("refresh_id").cloned().unwrap_or_default();
            refresh::status(host, &id)
        }
        ("GET", "/outlook-calendar") => outlook::status(host),
        ("POST", "/outlook-calendar/connect") => outlook::connect(host),
        ("POST", "/outlook-calendar/refresh") => outlook::refresh(host),
        ("POST", "/outlook-calendar/disconnect") => outlook::disconnect(host),
        ("GET", "/admin/accounts") => accounts::admin_list(host).map(|b| (200, b)),
        _ => Err(Error::new(404, "Connectors route not found")),
    }
}
