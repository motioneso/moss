//! Finance package, part 20: the account list, manual account creation and manual entries, private
//! to each owner. Everything crosses the guest-safe SDK Host interface. No model, network or job
//! port is used, and no amount or account name is written to logs, jobs or activity rows.
/// Leaves with the refusal when a reader fails.
macro_rules! ask {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(refusal) => return Ok(Err(refusal)),
        }
    };
}

pub mod accounts;
pub mod csv_import;
pub mod input;
pub mod ledger;
pub mod sorting;
pub mod text;
pub mod tools;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::json;

/// Routes use the module-relative path template. A host failure leaves as a fixed message,
/// because host errors can carry request text.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/finance/accounts") => accounts::list(host).map(|v| Response::new(200, v)),
        ("GET", "/finance/manual/context") => accounts::context(host).map(|v| Response::new(200, v)),
        ("POST", "/finance/manual/accounts") => {
            tools::route_write(ledger::create_account(host, &request.body))
        }
        ("POST", "/finance/manual/entries") => {
            tools::route_write(ledger::create_entry(host, &request.body))
        }
        ("POST", "/finance/chat/manual/account-create") => chat(host, "finance.manual.account-create", &request),
        ("POST", "/finance/chat/manual/entry-create") => chat(host, "finance.manual.entry-create", &request),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    result.unwrap_or_else(|_| Response::new(500, json!({"error":"Internal server error"})))
}

/// The assistant's write path. The host checks the account's one-use approval before it runs.
fn chat<H: Host + ?Sized>(host: &H, tool: &str, request: &RouteRequest) -> moss_module_sdk::Result<Response> {
    let reply = host.call("tools", "run", tool, json!({"parameters":request.body}))?;
    Ok(Response::new(200, reply))
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(
    host: &H,
    kind: &str,
    payload: &str,
) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route(host, request))?)
        }
        "tool" => {
            let result = tools::execute(host, serde_json::from_str(payload)?)
                .map_err(|_| moss_module_sdk::Error::new("Finance tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        _ => Err(moss_module_sdk::Error::new("Unsupported Finance invocation")),
    }
}
