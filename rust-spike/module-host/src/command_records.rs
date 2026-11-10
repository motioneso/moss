//! Immutable account/module records for queue command references. The caller holds
//! LocalPorts' process and disk locks across read/create; no collection read/replace.
use crate::runtime::Request;
use anyhow::{bail, ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime};
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

/// Most records one account may hold per resource. Records are immutable, so the bound
/// stops repeated requests from growing storage without limit.
const MAX_RECORDS: usize = 10_000;

/// Records older than this are no longer referenced by any live job, so a full account
/// may drop them to make room.
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

pub(crate) fn invoke(account: &VaultContext, request: &Request) -> Result<Value> {
    invoke_with_limit(account, request, MAX_RECORDS, RETENTION)
}

/// Removes records past `retention`. Returns how many entries remain.
fn prune(account: &VaultContext, folder: &str, retention: Duration) -> Result<usize> {
    let mut remaining = 0;
    for entry in account.list(folder)? {
        let path = format!("{folder}/{}", entry.name);
        let age = account
            .modified(&path)
            .ok()
            .and_then(|time| SystemTime::now().duration_since(time).ok());
        match age {
            Some(age) if age > retention => account.remove(&path)?,
            _ => remaining += 1,
        }
    }
    Ok(remaining)
}

fn invoke_with_limit(
    account: &VaultContext,
    request: &Request,
    max_records: usize,
    retention: Duration,
) -> Result<Value> {
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
            if account.list(&folder)?.len() >= max_records {
                ensure!(
                    prune(account, &folder, retention)? < max_records,
                    "Too many stored commands for this account"
                );
            }
            account.write(&path, &serde_json::to_vec(&value)?)?;
            Ok(json!({"created":true,"value":value}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn new_records_stop_at_the_limit_but_existing_ones_still_replay() {
        let data = tempfile::tempdir().unwrap();
        let root = vault::Root::create(&data.path().join("files")).unwrap();
        let module = root.create_subdir("m").unwrap();
        let ctx = access_context::AccessContext::new(uuid::Uuid::new_v4(), "quota");
        let account = VaultContext::for_module_files(&module, &ctx).unwrap();
        let put = |id: uuid::Uuid| {
            let request = Request {
                operation: "records.put".into(),
                resource: "commands".into(),
                parameters: json!({"id":id,"value":{"n":1}}),
            };
            invoke_with_limit(&account, &request, 2, Duration::from_secs(3600))
        };
        let first = uuid::Uuid::new_v4();
        assert_eq!(put(first).unwrap()["created"], true);
        assert_eq!(put(uuid::Uuid::new_v4()).unwrap()["created"], true);
        assert!(put(uuid::Uuid::new_v4()).is_err());
        assert_eq!(put(first).unwrap()["created"], false);
    }

    #[test]
    fn a_full_account_drops_only_expired_records() {
        let data = tempfile::tempdir().unwrap();
        let root = vault::Root::create(&data.path().join("files")).unwrap();
        let module = root.create_subdir("m").unwrap();
        let ctx = access_context::AccessContext::new(uuid::Uuid::new_v4(), "prune");
        let account = VaultContext::for_module_files(&module, &ctx).unwrap();
        let put = |id: uuid::Uuid, retention: Duration| {
            let request = Request {
                operation: "records.put".into(),
                resource: "commands".into(),
                parameters: json!({"id":id,"value":{"n":1}}),
            };
            invoke_with_limit(&account, &request, 2, retention)
        };
        let day = Duration::from_secs(86_400);
        let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        put(a, day).unwrap();
        put(b, day).unwrap();
        // Nothing is old yet, so the account stays full.
        assert!(put(uuid::Uuid::new_v4(), day).is_err());
        assert_eq!(put(a, day).unwrap()["created"], false);
        // With a zero retention both are expired and a new record fits.
        std::thread::sleep(Duration::from_millis(20));
        let fresh = put(uuid::Uuid::new_v4(), Duration::from_millis(1)).unwrap();
        assert_eq!(fresh["created"], true);
        assert_eq!(
            put(a, day).unwrap()["created"],
            true,
            "expired record was removed"
        );
    }
}
