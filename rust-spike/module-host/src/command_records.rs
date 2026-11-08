//! Immutable account/module records for queue command references. The caller holds
//! LocalPorts' process and disk locks across read/create; no collection read/replace.
use crate::runtime::Request;
use anyhow::{bail, ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use vault::VaultContext;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    id: uuid::Uuid,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Put {
    id: uuid::Uuid,
    value: Value,
}

pub(crate) fn invoke(account: &VaultContext, request: &Request) -> Result<Value> {
    let (id, value) = match request.operation.as_str() {
        "records.get" => (
            serde_json::from_value::<Read>(request.parameters.clone())?.id,
            None,
        ),
        "records.put" => {
            let put: Put = serde_json::from_value(request.parameters.clone())?;
            ensure!(!put.value.is_null(), "A command record cannot be null");
            ensure!(
                serde_json::to_vec(&put.value)?.len() <= 64 * 1024,
                "The command record is too large"
            );
            (put.id, Some(put.value))
        }
        _ => bail!("Unknown record operation"),
    };
    // The namespace comes from the approved resource, never a guest path.
    let folder = format!(
        "records-{}",
        crate::trust::digest(request.resource.as_bytes())
    );
    account.create_dir(&folder)?;
    let path = format!("{folder}/{id}.json");
    let old = match account.read(&path) {
        Ok(bytes) => Some(serde_json::from_slice::<Value>(&bytes)?),
        Err(vault::VaultError::NotFound(_)) => None,
        Err(e) => return Err(e.into()),
    };
    match value {
        None => Ok(old.unwrap_or(Value::Null)),
        Some(value) => {
            if let Some(old) = old {
                return Ok(json!({"created":false,"value":old}));
            }
            account.write(&path, &serde_json::to_vec(&value)?)?;
            Ok(json!({"created":true,"value":value}))
        }
    }
}
