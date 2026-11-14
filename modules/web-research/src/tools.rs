//! The `web.search` chat tool. The host picks the person, so no tool takes a person from the
//! request. `web.read` arrives with page reading and is not declared yet.
use crate::search;
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
        _ => Err(moss_module_sdk::Error::new("Unknown Web Research tool")),
    }
}
