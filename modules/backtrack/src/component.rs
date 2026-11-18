//! Generated canonical ABI; domain effects use the declared public host ports.
use moss_module_sdk::{Error, Host};
use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wit", world: "backtrack" });

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
            "jobs" => moss::module::jobs::call(&request),
            "api" => moss::module::api::call(&request),
            _ => return Err(Error::new("Unsupported Backtrack host port")),
        }
        .map_err(|_| Error::new("Backtrack host call failed"))?;
        Ok(serde_json::from_str(&response)?)
    }
}
struct Backtrack;
impl Guest for Backtrack {
    fn handle(kind: String, payload: String) -> std::result::Result<String, String> {
        crate::handle(&ComponentHost, &kind, &payload)
            .map_err(|_| "Backtrack invocation failed".to_owned())
    }
}
export!(Backtrack);
