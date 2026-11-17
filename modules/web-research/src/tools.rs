//! The `web.search` and `web.read` chat tools. The host picks the person, so no tool takes a
//! person from the request.
use crate::{reader, search};
use moss_module_sdk::{Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub tool: String,
    pub parameters: Value,
}

pub fn handle<H: Host + ?Sized>(host: &H, request: ToolRequest) -> Result<Value> {
    match request.tool.as_str() {
        "web.search" => Ok(match search::run(host, &request.parameters) {
            Ok(data) => json!({"data": data}),
            Err(message) => json!({"data": {"error": message}}),
        }),
        "web.read" => Ok(json!({"data": reader::run(host, &request.parameters)?})),
        _ => Err(moss_module_sdk::Error::new("Unknown Web Research tool")),
    }
}
