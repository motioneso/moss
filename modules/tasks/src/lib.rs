//! Tasks package data core. All effects cross the guest-safe SDK Host interface.
mod breakdown;
mod heartbeat;
mod jobs;
pub mod dates;
mod mutations;
pub mod parse;
pub mod recurrence;
pub mod repository;
pub mod routes;
pub mod rows;
pub mod task_fields;
pub mod tasks;
mod tool_fields;
mod tool_schemas;
pub mod tools;
pub mod validation;

pub mod schema;
pub mod schemas;

#[cfg(target_arch = "wasm32")]
mod component;

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: moss_module_sdk::Host + ?Sized>(
    host: &H,
    kind: &str,
    payload: &str,
) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&routes::handle(host, request))?)
        }
        "tool" => {
            let request = serde_json::from_str(payload)?;
            let result = tools::handle(host, request)
                .map_err(|_| moss_module_sdk::Error::new("Tasks tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        "job" => jobs::handle(host, payload),
        _ => Err(moss_module_sdk::Error::new("Unsupported Tasks invocation")),
    }
}
