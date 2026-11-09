//! Public export handler. No caller-selected account, table or SQL is accepted.
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(tag = "name", content = "parameters")]
enum ApiRequest {
    #[serde(rename = "collectManagedNotesExportSection")]
    Export(Empty),
    #[serde(rename = "prepareNoteAction")]
    Prepare(PrepareRequest),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareRequest {
    tool: String,
    // A JSON string preserves field order through the host's deterministic maps.
    input_json: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub fn handle(host: &impl Host, kind: &str, payload: &str) -> Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => crate::routes::handle(host, payload),
        #[cfg(feature = "write-tools")]
        "job" => crate::sync::handle(host, payload),
        "tool" => {
            let request: Value = serde_json::from_str(payload)?;
            if request["tool"] == "notes.search" {
                return crate::search::handle(host, payload);
            }
            #[cfg(feature = "write-tools")]
            return crate::write_tools::handle(host, payload);
            #[cfg(not(feature = "write-tools"))]
            Err(Error::new("Notes tool is not available"))
        }
        "api" => {
            let request: ApiRequest = serde_json::from_str(payload)?;
            let result: Value = match request {
                ApiRequest::Export(_) => crate::export::collect(host)?,
                ApiRequest::Prepare(request) => {
                    match crate::write_tools::prepare_json(host, &request.tool, &request.input_json)
                    {
                        Ok(details) => json!({"ok":details}),
                        // Known tool failures use fixed messages; raw backend text never
                        // reaches this API. A typed value survives the host's guest-error scrub.
                        Err(error) => {
                            json!({"error":serde_json::from_str::<Value>(&error.message).unwrap_or_else(|_|json!({"statusCode":503,"error":"Notes service is unavailable"}))})
                        }
                    }
                }
            };
            Ok(serde_json::to_string(&result)?)
        }
        _ => Err(Error::new("Notes handler is not available")),
    }
}
