//! Meals package, part 28: the kitchen and household, with their four chat tools. Each
//! person's rows are private to them. All effects cross the guest-safe SDK Host interface.
pub mod account;
pub mod arrange;
pub mod cooking;
pub mod diary;
pub mod draft;
pub mod estimate;
pub mod favourites;
pub mod input;
pub mod jobs;
pub mod kitchen;
pub mod list;
pub mod log;
pub mod md5;
pub mod moments;
pub mod nutrients;
pub mod pantry;
pub mod plans;
pub mod recipe;
pub mod shopping;
pub mod rules;
pub mod safety;
pub mod safety_terms;
pub mod stock;
pub mod swap;
pub mod store;
pub mod tools;
pub mod undo;
pub mod units;
pub mod util;
pub mod view;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::json;

pub const KITCHENS: &str = "app.meals_kitchens";

/// Old Meals had no HTTP routes, so the only route is the transport for the chat tools.
pub fn route<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let result = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/meals/tools/run") => tools::run(host, &request.body),
        _ => return Response::new(404, json!({"message":"Route not found"})),
    };
    // A host failure leaves as a fixed message, because host errors can carry request text.
    result.unwrap_or_else(|_| Response::new(500, json!({"error":"Internal server error"})))
}

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: Host + ?Sized>(
    host: &H,
    kind: &str,
    payload: &str,
) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "tool" => {
            let result = serde_json::from_str(payload)
                .map_err(|_| moss_module_sdk::Error::new("Invalid Meals tool request"))
                .and_then(|request| tools::handle(host, request))
                .map_err(|_| moss_module_sdk::Error::new("Meals tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        "job" => jobs::handle(host, payload),
        "api" => {
            let call = account::execute(host, serde_json::from_str(payload)?)
                .map_err(|_| moss_module_sdk::Error::new("Meals account operation failed"))?;
            Ok(serde_json::to_string(&call)?)
        }
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route(host, request))?)
        }
        _ => Err(moss_module_sdk::Error::new("Unsupported Meals invocation")),
    }
}
