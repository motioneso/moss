//! Recording memory API. It validates each request, forwards it to the host and turns a
//! refusal into a plain status. The host owns the SQL and the lineage rules.
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

const UNAVAILABLE: &str = "This recording memory is unavailable";
const INPUT: &str = "Recording facts require nonempty text of at most 2048 UTF-8 bytes";
const CHANGED: &str =
    "This recording's memory has changed or is being removed; refresh its saved state before continuing";

const ACTIONS: &[&str] = &[
    "inspect",
    "export",
    "prepare",
    "apply",
    "transfer",
    "synchronize",
    "cleanup",
    "assertComplete",
    "retireSource",
];

fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn text_ok(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 2048 && !s.contains('\0')
}

fn revision_ok(v: &Value) -> bool {
    v.is_null() || v.as_i64().is_some_and(|n| (0..=2147483645).contains(&n))
}

fn fact_revision_ok(v: &Value) -> bool {
    v.is_null()
        || v.as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 19
                && s.bytes().all(|b| b.is_ascii_digit())
                && (s == "0" || !s.starts_with('0'))
        })
}

fn source_ok(v: &Value) -> bool {
    v["sourceModuleId"] == "meetings"
        && v["sourceId"].as_str().is_some_and(is_uuid)
        && v["sourceVersion"]
            .as_i64()
            .is_some_and(|n| (1..=2147483645).contains(&n))
        && v["itemKey"].as_str().is_some_and(|k| {
            (1..=80).contains(&k.len())
                && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

fn prepare_ok(input: &Value) -> Result<()> {
    let kinds = ["apply", "change", "undo", "restore", "reconcile_side"];
    let kind = input["kind"].as_str().unwrap_or("");
    let request_id = input["requestId"].as_str().unwrap_or("");
    if !kinds.contains(&kind) || !(1..=256).contains(&request_id.len()) || request_id.contains('\0') {
        return Err(Error::new(400, INPUT));
    }
    if kind == "apply" && !source_ok(&input["source"]) {
        return Err(Error::new(404, UNAVAILABLE));
    }
    if kind != "apply" {
        let id = input["receiptId"].as_str().unwrap_or("");
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(Error::new(404, UNAVAILABLE));
        }
    }
    if let Some(text) = input["text"].as_str() {
        if !text_ok(text) {
            return Err(Error::new(400, INPUT));
        }
    } else if !input["text"].is_null() {
        return Err(Error::new(400, INPUT));
    }
    if !revision_ok(&input["expectedRevision"]) || !fact_revision_ok(&input["expectedFactRevision"]) {
        return Err(Error::new(409, CHANGED));
    }
    Ok(())
}

/// Checks the request shape. Anything a person could mistype is refused here; the host
/// repeats the checks that guard stored data.
fn check(action: &str, p: &Value) -> Result<()> {
    match action {
        "inspect" if !source_ok(&p["source"]) => Err(Error::new(404, UNAVAILABLE)),
        "prepare" => prepare_ok(&p["input"]),
        "apply" if !p["proposalId"].as_str().is_some_and(is_uuid) => Err(Error::new(404, UNAVAILABLE)),
        "transfer" | "synchronize" => {
            let key = if action == "transfer" { "fromIds" } else { "factIds" };
            let ids = p[key].as_array();
            let ok = ids.is_some_and(|a| a.iter().all(|i| i.as_str().is_some_and(is_uuid)))
                && (action == "synchronize" || p["replacementId"].as_str().is_some_and(is_uuid));
            if ok { Ok(()) } else { Err(Error::new(409, CHANGED)) }
        }
        "cleanup" | "assertComplete" | "retireSource" if !p["operationId"].as_str().is_some_and(is_uuid) => {
            Err(Error::new(409, CHANGED))
        }
        _ => Ok(()),
    }
}

pub fn call(host: &impl Host, parameters: &Value) -> Result<Value> {
    let action = parameters["action"].as_str().unwrap_or("");
    if !ACTIONS.contains(&action) {
        return Err(Error::new(400, "Invalid memory request"));
    }
    check(action, parameters)?;
    let operation = if matches!(action, "inspect" | "export") { "get" } else { "set" };
    let answer = kv(host, operation, "memory.recording", parameters.clone())?;
    if let Some(refused) = answer.get("refused") {
        return Err(Error::new(
            refused["status"].as_u64().unwrap_or(409) as u16,
            refused["message"].as_str().unwrap_or(CHANGED),
        ));
    }
    Ok(json!(answer))
}
