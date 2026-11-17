//! Account lifecycle: only this note, under the authenticated account's row policies.
use crate::store::call;
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Api {
    name: String,
    parameters: Value,
}

pub fn execute<H: Host + ?Sized>(host: &H, api: Api) -> Result<Value> {
    match api.name.as_str() {
        "prepareScratchpadSettings" => crate::tools::prepare_settings(host, &api.parameters),
        "prepareScratchpadAction" => crate::tools::prepare(host, &api.parameters),
        "collectScratchpadExportSection" | "deleteScratchpadAccountData" => {
            if api.parameters != json!({}) {
                return Err(Error::new("Account operation takes no parameters"));
            }
            call(
                host,
                if api.name == "collectScratchpadExportSection" {
                    "export"
                } else {
                    "delete"
                },
                json!({}),
            )
        }
        _ => Err(Error::new("Unknown Scratchpad API")),
    }
}
