//! Generated canonical ABI; domain effects use the declared public host ports.
use moss_module_sdk::{Error, Host};
use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wit", world: "scratchpad" });

struct ComponentHost;
impl Host for ComponentHost {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> moss_module_sdk::Result<Value> {
        let request = serde_json::to_string(
            &json!({"operation":operation,"resource":resource,"parameters":parameters}),
        )?;
        let response = match port {
            "context" => moss::module::context::call(&request),
            "kv" => moss::module::kv::call(&request),
            _ => return Err(Error::new("Unsupported Scratchpad host port")),
        }
        .map_err(|_| Error::new("Scratchpad host call failed"))?;
        Ok(serde_json::from_str(&response)?)
    }
}
struct Scratchpad;
impl Guest for Scratchpad {
    fn handle(kind: String, payload: String) -> std::result::Result<String, String> {
        crate::handle(&ComponentHost, &kind, &payload)
            .map_err(|_| "Scratchpad invocation failed".to_owned())
    }
}
export!(Scratchpad);
