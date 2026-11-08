//! Public export handler. No caller-selected account, table or SQL is accepted.
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApiRequest {
    name: String,
    parameters: Empty,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub fn handle(host: &impl Host, kind: &str, payload: &str) -> Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => crate::routes::handle(host, payload),
        "api" => {
            let request: ApiRequest = serde_json::from_str(payload)?;
            let _ = request.parameters;
            let result: Value = match request.name.as_str() {
                "collectManagedNotesExportSection" => crate::export::collect(host)?,
                _ => return Err(Error::new("Unknown Notes API")),
            };
            Ok(serde_json::to_string(&result)?)
        }
        _ => Err(Error::new("Notes handler is not available")),
    }
}
