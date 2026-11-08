//! Generated canonical ABI for the shipping People component. Shared port WIT
//! remains in the host; this world selects only the ports People actually uses.
use moss_module_sdk::{Error, Host, Result as SdkResult};
use serde_json::{json, Value};

wit_bindgen::generate!({
    path: "../../../rust-spike/module-host/wit",
    inline: "package moss:people@0.1.0;
        world people {
            import moss:module/db@1.0.0;
            import moss:module/context@1.0.0;
            import moss:module/vault@1.0.0;
            export handle: func(kind: string, payload: string) -> result<string, string>;
        }",
    world: "people",
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
        let request = serde_json::to_string(
            &json!({"operation":operation,"resource":resource,"parameters":parameters}),
        )?;
        let reply = match port {
            "db" => moss::module::db::call(&request),
            "context" => moss::module::context::call(&request),
            "vault" => moss::module::vault::call(&request),
            _ => return Err(Error::new("The People component does not import this port")),
        }
        .map_err(Error::new)?;
        Ok(serde_json::from_str(&reply)?)
    }
}
struct People;
impl Guest for People {
    fn handle(kind: String, payload: String) -> core::result::Result<String, String> {
        crate::guest::handle(&Ports, &kind, &payload).map_err(|error| error.message)
    }
}
export!(People);
