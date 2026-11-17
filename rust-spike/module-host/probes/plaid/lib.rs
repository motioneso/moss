//! Test-only guest for the Finance part 19 live run. It asks the host broker to swap a public
//! token and to read balances. It never holds a key or a bank token.
#[cfg(target_arch = "wasm32")]
mod component;

use moss_module_sdk::{Host, Response, RouteRequest};
use serde_json::{json, Value};

const SANDBOX: &str = "sandbox.plaid.com";

fn broker<H: Host + ?Sized>(host: &H, operation: &str, url: &str, credential: &str, slot: &str) -> Value {
    let mut parameters = json!({"url": url, "credential": credential, "slot": slot});
    if operation == "request" {
        parameters["method"] = json!("POST");
        parameters["body"] = json!({});
    }
    match host.call("credentials", operation, SANDBOX, parameters) {
        Ok(value) => value,
        Err(_) => json!({"refused": true}),
    }
}

pub fn route_from<H: Host + ?Sized>(host: &H, request: RouteRequest) -> Response {
    let slot = request.body["slot"].as_str().unwrap_or("bank-1");
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/status") => Response::new(
            200,
            json!({
                "keys": host.call("credentials", "status", SANDBOX, json!({"credential":"plaid-keys"})).unwrap_or(json!({"refused":true})),
                "bank": host.call("credentials", "status", SANDBOX, json!({"credential":"plaid-item","slot":slot})).unwrap_or(json!({"refused":true})),
            }),
        ),
        ("POST", "/link") => {
            let mut parameters = json!({
                "url": "https://production.plaid.com/item/public_token/exchange",
                "credential": "plaid-item",
                "slot": slot,
                "public_token": request.body["public_token"],
            });
            parameters["input"] = request.body["public_token"].clone();
            let reply = host
                .call("credentials", "exchange", "production.plaid.com", parameters)
                .unwrap_or(json!({"refused": true}));
            Response::new(200, reply)
        }
        ("POST", "/balance") => Response::new(
            200,
            broker(host, "request", "https://sandbox.plaid.com/accounts/balance/get", "plaid-item", slot),
        ),
        _ => Response::new(404, json!({"message": "Route not found"})),
    }
}

pub fn handle<H: Host + ?Sized>(host: &H, kind: &str, payload: &str) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request: RouteRequest = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&route_from(host, request))?)
        }
        _ => Err(moss_module_sdk::Error::new("Unsupported probe invocation")),
    }
}
