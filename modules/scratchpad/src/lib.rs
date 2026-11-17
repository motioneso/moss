//! Scratchpad package core: the one private note per person, its save, append and settings.
//! All effects cross the guest-safe SDK Host interface.
pub mod account;
pub mod routes;
pub mod shortcut;
pub mod store;
pub mod tools;

pub use routes::route;

#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, RouteRequest};

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
            Ok(serde_json::to_string(&routes::route(host, request))?)
        }
        "tool" | "api" => {
            let result = (|| {
                if kind == "tool" {
                    tools::execute(host, serde_json::from_str(payload)?)
                } else {
                    account::execute(host, serde_json::from_str(payload)?)
                }
            })()
            .map_err(|_| moss_module_sdk::Error::new("Scratchpad operation failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        _ => Err(moss_module_sdk::Error::new(
            "Unsupported Scratchpad invocation",
        )),
    }
}
