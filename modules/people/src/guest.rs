//! Package entry point. Only completed read APIs are enabled at this checkpoint.
use crate::repository::Repository;
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApiRequest {
    name: String,
    parameters: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolve {
    query: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Person {
    person_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}

pub fn handle(host: &impl Host, kind: &str, payload: &str) -> Result<String> {
    if kind == "health" {
        return Ok("healthy".into());
    }
    if kind != "api" {
        return Err(Error::new("People handler is not available"));
    }
    let request: ApiRequest = serde_json::from_str(payload)?;
    let repo = Repository::new(host);
    let value = match request.name.as_str() {
        "resolve" => {
            let args: Resolve = serde_json::from_value(request.parameters)?;
            json!({"person":repo.resolve(&args.query)?})
        }
        "getPerson" => {
            let args: Person = serde_json::from_value(request.parameters)?;
            repo.detail(&args.person_id)?
        }
        "listEmailIdentityValues" => {
            let _: Empty = serde_json::from_value(request.parameters)?;
            json!(repo.list_email_identity_values()?)
        }
        _ => return Err(Error::new("Unknown People API")),
    };
    Ok(serde_json::to_string(&value)?)
}
