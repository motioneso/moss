//! Memory guest. It owns the package identity, the tables and the vault index jobs. Embedding settings are
//! served by the host so the credential never reaches guest code, and graph access, recall,
//! remembering and candidates are not in this package yet.
use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::json;

#[cfg(target_arch = "wasm32")]
mod abi;
mod vault_index;

pub fn handle(host: &impl Host, kind: &str, payload: &str) -> Result<String, String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let response = match serde_json::from_str::<RouteRequest>(payload) {
                Ok(_) => Response::new(404, json!({"error":"Memory route not found"})),
                Err(_) => Response::new(400, json!({"error":"Invalid memory request"})),
            };
            serde_json::to_string(&response).map_err(|_| "Invalid memory response".into())
        }
        "job" => vault_index::handle_job(host, payload).map_err(|e| e.message),
        "api" => {
            #[derive(serde::Deserialize)]
            #[serde(tag = "name", content = "parameters", deny_unknown_fields)]
            enum Api {
                #[serde(rename = "requestVaultIndex")]
                RequestVaultIndex(vault_index::NudgeRequest),
            }
            let Api::RequestVaultIndex(input) =
                serde_json::from_str(payload).map_err(|_| "Invalid memory request".to_owned())?;
            vault_index::request(host, input)
                .map(|v| v.to_string())
                .map_err(|e| e.message)
        }
        _ => Err("Memory handler is unavailable".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moss_module_sdk::{Error, Result};
    use serde_json::Value;

    struct NoPorts;
    impl Host for NoPorts {
        fn call(&self, _: &str, _: &str, _: &str, _: Value) -> Result<Value> {
            Err(Error::new("no ports"))
        }
    }

    #[test]
    fn health_succeeds_and_unknown_routes_are_404() {
        assert_eq!(handle(&NoPorts, "health", "{}").unwrap(), "{}");
        let out = handle(
            &NoPorts,
            "route",
            r#"{"method":"GET","path":"/x","params":{},"query":{},"body":null}"#,
        )
        .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["status"], 404);
    }

    #[test]
    fn unknown_kinds_are_refused() {
        assert!(handle(&NoPorts, "other", "{}").is_err());
    }
}
