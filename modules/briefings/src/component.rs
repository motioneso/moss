//! Generated canonical ABI; domain effects use the declared public host ports.
use moss_module_sdk::{Error, Host};
use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wit", world: "briefings" });

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
            "db" => moss::module::db::call(&request),
            "context" => moss::module::context::call(&request),
            "jobs" => moss::module::jobs::call(&request),
            "notify" => moss::module::notify::call(&request),
            "api" => moss::module::api::call(&request),
            "ai" => moss::module::ai::call(&request),
            _ => return Err(Error::new("Unsupported Briefings host port")),
        }
        .map_err(|_| Error::new("Briefings host call failed"))?;
        Ok(serde_json::from_str(&response)?)
    }
}
struct Briefings;
impl Guest for Briefings {
    fn handle(kind: String, payload: String) -> std::result::Result<String, String> {
        crate::handle(&ComponentHost, &kind, &payload)
            .map_err(|_| "Briefings invocation failed".to_owned())
    }
}
export!(Briefings);
