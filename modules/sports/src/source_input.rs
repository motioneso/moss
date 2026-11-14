//! Request body checks for the source routes. The messages follow the wording the old route
//! schema gave, and the first failure is the one reported.
use crate::source_scope::{is_sport_key, Target, ASSIGNMENT_LIMIT};
use crate::util::is_uuid;
use serde_json::{Map, Value};

pub struct Assignment {
    pub target: Target,
    pub exact_target_url: Option<String>,
}

pub struct Confirm {
    pub confirmation_id: String,
    pub acknowledgement: String,
    pub canonical_domain: String,
    pub confirmed_fetch_hosts: Vec<String>,
    pub targets: Vec<(Target, String)>,
}

fn object<'a>(value: &'a Value, at: &str) -> Result<&'a Map<String, Value>, String> {
    value.as_object().ok_or_else(|| format!("{at} must be object"))
}

fn only(map: &Map<String, Value>, allowed: &[&str], at: &str) -> Result<(), String> {
    if map.keys().all(|k| allowed.contains(&k.as_str())) {
        Ok(())
    } else {
        Err(format!("{at} must NOT have additional properties"))
    }
}

fn required(map: &Map<String, Value>, name: &str, at: &str) -> Result<(), String> {
    if map.contains_key(name) {
        Ok(())
    } else {
        Err(format!("{at} must have required property '{name}'"))
    }
}

fn text(value: &Value, at: &str, min: usize, max: usize) -> Result<String, String> {
    let Some(text) = value.as_str() else { return Err(format!("{at} must be string")) };
    let length = text.chars().count();
    if length < min {
        return Err(format!("{at} must NOT have fewer than {min} characters"));
    }
    if length > max {
        return Err(format!("{at} must NOT have more than {max} characters"));
    }
    Ok(text.to_owned())
}

fn https_url(value: &Value, at: &str) -> Result<String, String> {
    let url = text(value, at, 0, 2048)?;
    if url.len() > "https://".len() && url.starts_with("https://") && !url.contains('\n') {
        Ok(url)
    } else {
        Err(format!("{at} must match pattern \"^https://.+$\""))
    }
}

fn list<'a>(value: &'a Value, at: &str, max: usize) -> Result<&'a Vec<Value>, String> {
    let Some(items) = value.as_array() else { return Err(format!("{at} must be array")) };
    if items.len() > max {
        return Err(format!("{at} must NOT have more than {max} items"));
    }
    Ok(items)
}

pub fn target(value: &Value, at: &str) -> Result<Target, String> {
    let fail = || format!("{at} must match exactly one schema in oneOf");
    let map = value.as_object().ok_or_else(fail)?;
    match map.get("kind").and_then(Value::as_str) {
        Some("sport") if map.len() == 2 => match map.get("sportKey").and_then(Value::as_str) {
            Some(key) if is_sport_key(key) => Ok(Target::Sport(key.to_owned())),
            _ => Err(fail()),
        },
        Some("follow") if map.len() == 2 => match map.get("followId").and_then(Value::as_str) {
            Some(id) if is_uuid(id) => Ok(Target::Follow(id.to_owned())),
            _ => Err(fail()),
        },
        _ => Err(fail()),
    }
}

fn assignments(value: &Value, at: &str) -> Result<Vec<Assignment>, String> {
    list(value, at, ASSIGNMENT_LIMIT)?
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let here = format!("{at}/{index}");
            let map = object(item, &here)?;
            only(map, &["target", "exactTargetUrl"], &here)?;
            required(map, "target", &here)?;
            let target = target(&map["target"], &format!("{here}/target"))?;
            let exact_target_url = match map.get("exactTargetUrl") {
                None => None,
                Some(url) => Some(https_url(url, &format!("{here}/exactTargetUrl"))?),
            };
            Ok(Assignment { target, exact_target_url })
        })
        .collect()
}

/// `{url, assignments?}` for a new source preview.
pub fn new_preview(body: &Value) -> Result<(String, Vec<Assignment>), String> {
    let map = object(body, "body")?;
    only(map, &["url", "assignments"], "body")?;
    required(map, "url", "body")?;
    let url = text(&map["url"], "body/url", 1, 2048)?;
    let items = match map.get("assignments") {
        None => Vec::new(),
        Some(value) => assignments(value, "body/assignments")?,
    };
    Ok((url, items))
}

/// `{assignments}` for a preview of one source's new targets.
pub fn assignments_preview(body: &Value) -> Result<Vec<Assignment>, String> {
    let map = object(body, "body")?;
    only(map, &["assignments"], "body")?;
    required(map, "assignments", "body")?;
    assignments(&map["assignments"], "body/assignments")
}

/// `{assignments}` for the ESPN coverage.
pub fn coverage(body: &Value) -> Result<Vec<Target>, String> {
    let map = object(body, "body")?;
    only(map, &["assignments"], "body")?;
    required(map, "assignments", "body")?;
    list(&map["assignments"], "body/assignments", ASSIGNMENT_LIMIT)?
        .iter()
        .enumerate()
        .map(|(index, item)| target(item, &format!("body/assignments/{index}")))
        .collect()
}

/// The body that confirms a preview, for a new source or for new targets.
pub fn confirm(body: &Value) -> Result<Confirm, String> {
    let map = object(body, "body")?;
    only(
        map,
        &["confirmationId", "authorizationAcknowledgement", "canonicalDomain", "confirmedFetchHosts", "targets"],
        "body",
    )?;
    for name in ["confirmationId", "authorizationAcknowledgement", "canonicalDomain", "confirmedFetchHosts", "targets"] {
        required(map, name, "body")?;
    }
    let confirmation_id = text(&map["confirmationId"], "body/confirmationId", 1, 256)?;
    let acknowledgement = text(&map["authorizationAcknowledgement"], "body/authorizationAcknowledgement", 1, 300)?;
    let canonical_domain = text(&map["canonicalDomain"], "body/canonicalDomain", 1, 253)?;
    let confirmed_fetch_hosts = list(&map["confirmedFetchHosts"], "body/confirmedFetchHosts", 6)?
        .iter()
        .enumerate()
        .map(|(index, host)| text(host, &format!("body/confirmedFetchHosts/{index}"), 1, 253))
        .collect::<Result<Vec<_>, _>>()?;
    let targets = list(&map["targets"], "body/targets", ASSIGNMENT_LIMIT)?
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let here = format!("body/targets/{index}");
            let entry = object(item, &here)?;
            only(entry, &["target", "targetUrl"], &here)?;
            required(entry, "target", &here)?;
            required(entry, "targetUrl", &here)?;
            Ok((target(&entry["target"], &format!("{here}/target"))?, https_url(&entry["targetUrl"], &format!("{here}/targetUrl"))?))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Confirm { confirmation_id, acknowledgement, canonical_domain, confirmed_fetch_hosts, targets })
}
