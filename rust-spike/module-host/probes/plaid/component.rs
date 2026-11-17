use moss_module_sdk::{Error, Host};
use serde_json::{json, Value};

wit_bindgen::generate!({ path: "wit", world: "plaid-probe" });

struct ComponentHost;
impl Host for ComponentHost {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> moss_module_sdk::Result<Value> {
        let request = serde_json::to_string(&json!({"operation":operation,"resource":resource,"parameters":parameters}))?;
        let response = match port {
            "credentials" => moss::module::credentials::call(&request),
            _ => return Err(Error::new("Unsupported probe host port")),
        }
        .map_err(|_| Error::new("Probe host call failed"))?;
        Ok(serde_json::from_str(&response)?)
    }
}
struct Probe;
impl Guest for Probe {
    fn handle(kind: String, payload: String) -> std::result::Result<String, String> {
        crate::handle(&ComponentHost, &kind, &payload).map_err(|_| "Probe invocation failed".to_owned())
    }
}
export!(Probe);
