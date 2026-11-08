//! Generated canonical ABI, with only the Notes guest's declared database import.
use moss_module_sdk::{Error, Host, Result as SdkResult};
use serde_json::{json, Value};

wit_bindgen::generate!({
    path: "../../../rust-spike/module-host/wit",
    inline: "package moss:notes@0.1.0;
        world notes {
            import moss:module/db@1.0.0;
            import moss:module/vault@1.0.0;
            export handle: func(kind: string, payload: string) -> result<string, string>;
        }",
    world: "notes",
    generate_all,
});

struct Ports;
impl Host for Ports {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> SdkResult<Value> {
        if !matches!(port, "db" | "vault") {
            return Err(Error::new("Notes does not import this port"));
        }
        let request = serde_json::to_string(
            &json!({"operation":operation,"resource":resource,"parameters":parameters}),
        )?;
        let response = match port {
            "db" => moss::module::db::call(&request),
            "vault" => moss::module::vault::call(&request),
            _ => unreachable!(),
        }
        .map_err(Error::new)?;
        Ok(serde_json::from_str(&response)?)
    }
}
struct Notes;
impl Guest for Notes {
    fn handle(kind: String, payload: String) -> core::result::Result<String, String> {
        crate::guest::handle(&Ports, &kind, &payload).map_err(|error| error.message)
    }
}
export!(Notes);
