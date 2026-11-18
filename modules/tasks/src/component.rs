//! Generated canonical ABI; domain effects use the declared public host ports.
use moss_module_sdk::{Error, Host};
use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wit", world: "tasks" });

// Mutation results may contain every moved task, including private descriptions.
// A successful public port call reports query success. Bulk
// deletion needs no returning values, so do not parse that unused JSON in Wasm.
pub(crate) fn execute_query(
    resource: &str,
    query: &moss_module_sdk::query::Query,
) -> moss_module_sdk::Result<()> {
    let request = serde_json::to_string(
        &json!({"operation":"query","resource":resource,"parameters":query}),
    )?;
    moss::module::db::call(&request).map_err(|_| Error::new("Tasks host call failed"))?;
    Ok(())
}

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
            "ai" => moss::module::ai::call(&request),
            "action-policy" => moss::module::action_policy::call(&request),
            "jobs" => moss::module::jobs::call(&request),
            _ => return Err(Error::new("Unsupported Tasks host port")),
        }
        .map_err(|_| Error::new("Tasks host call failed"))?;
        Ok(serde_json::from_str(&response)?)
    }
}
struct Tasks;
impl Guest for Tasks {
    fn handle(kind: String, payload: String) -> std::result::Result<String, String> {
        crate::handle(&ComponentHost, &kind, &payload)
            .map_err(|_| "Tasks invocation failed".to_owned())
    }
}
export!(Tasks);
