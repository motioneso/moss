//! Approval cards for the source tools. A card is built from the saved source, the saved follows
//! and the stored preview, never from text the model supplied. The version string changes when
//! any of those change, so an approval given for one card cannot run against another.
use crate::source_preview;
use crate::source_routes::{follow_rows, ACKNOWLEDGEMENT};
use crate::source_scope::sport_label;
use crate::sources;
use crate::teams::TeamList;
use crate::util::is_uuid;
use crate::catalog;
use moss_module_sdk::{Host, Result};
use serde_json::{json, Map, Value};

const REMOVAL: [(&str, &str); 2] = [
    ("Source and coverage", "Remove this sports news source and all its coverage assignments."),
    (
        "Stored photos",
        "Delete stored photos for this source. Any copies left after a cleanup failure are removed during later cleanup.",
    ),
];
const REPLACEMENT: &str = "Replace all coverage assignments for this source with the complete list shown. Any assignment not listed will be removed.";
const CLEARED: &str = "Remove all coverage assignments for this source.";

/// What each tool shows and which preview kind it confirms.
pub fn action(tool: &str) -> Option<(&'static str, &'static str, bool)> {
    Some(match tool {
        "sports.confirmSource" => ("Add sports news source", "new-source", false),
        "sports.confirmSourceAssignments" => ("Change sports source coverage", "assignment-replacement", true),
        "sports.confirmSourceRecipe" => ("Change sports source instructions", "recipe-rebuild", true),
        "sports.retrySource" => ("Retry sports news source", "retry", true),
        "sports.removeSource" => ("Remove sports news source", "remove", true),
        _ => return None,
    })
}

fn field(label: &str, value: &str) -> Value {
    json!({"label":label,"value":value})
}

/// The source's name and domain, with the saved row as its version.
fn source_label<H: Host + ?Sized>(host: &H, id: &Value) -> Result<Option<(String, Value)>> {
    let Some(id) = id.as_str().filter(|id| is_uuid(id)) else { return Ok(None) };
    let Some((row, _)) = sources::find(host, id)? else { return Ok(None) };
    let (Some(label), Some(domain)) = (row["label"].as_str(), row["canonical_domain"].as_str()) else { return Ok(None) };
    let version = json!({"id":row["id"],"label":row["label"],"canonical_domain":row["canonical_domain"],"updated_at":row["updated_at"]});
    Ok(Some((format!("{label} ({domain})"), version)))
}

/// A coverage choice as the person sees it. A followed team needs ESPN's list to name it.
fn target_label(follows: &[Value], teams: &dyn TeamList, target: &Value) -> Option<(String, Value)> {
    let map = target.as_object().filter(|m| m.len() == 2)?;
    match map.get("kind")?.as_str()? {
        "sport" => {
            let key = map.get("sportKey")?.as_str()?;
            crate::source_scope::is_sport_key(key).then(|| (sport_label(key).to_owned(), target.clone()))
        }
        "follow" => {
            let id = map.get("followId")?.as_str()?;
            let row = follows.iter().find(|row| row["id"].as_str() == Some(id))?;
            let competition = catalog::entry(row["competition_key"].as_str()?)?.label;
            if row["team_key"].is_null() {
                return Some((competition.to_owned(), row.clone()));
            }
            let team_id = row["source_team_id"].as_str()?;
            let all = teams.teams(row["competition_key"].as_str()?);
            let mut found = all.iter().filter(|t| t.source_team_id.as_deref() == Some(team_id));
            let team = found.next().filter(|_| found.next().is_none())?;
            Some((format!("{} ({competition})", team.name), json!([row, [row["competition_key"], team_id, team.name]])))
        }
        _ => None,
    }
}

/// Exactly these keys, no more and no fewer.
fn exact<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let map = input.as_object()?;
    (map.len() == keys.len() && keys.iter().all(|k| map.contains_key(*k))).then_some(map)
}

/// The card for one tool call, or `None` when the call cannot be shown in full.
pub fn card<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, tool: &str, input: &Value) -> Result<Option<Value>> {
    let Some((title, kind, has_source)) = action(tool) else { return Ok(None) };
    if kind == "remove" || kind == "retry" {
        if exact(input, &["sourceId"]).is_none() {
            return Ok(None);
        }
        let Some((label, version)) = source_label(host, &input["sourceId"])? else { return Ok(None) };
        let mut fields = vec![field("Source", &label)];
        if kind == "remove" {
            fields.extend(REMOVAL.iter().map(|(l, v)| field(l, v)));
        }
        return Ok(Some(json!({
            "title": title, "content": if kind == "remove" { "user_authored" } else { "outside" },
            "target": label, "fields": fields, "version": version.to_string(),
        })));
    }
    let mut keys = vec!["confirmationId", "authorizationAcknowledgement", "canonicalDomain", "confirmedFetchHosts", "targets"];
    if has_source {
        keys.insert(0, "sourceId");
    }
    if exact(input, &keys).is_none() {
        return Ok(None);
    }
    let source = if has_source {
        match source_label(host, &input["sourceId"])? {
            Some(found) => Some(found),
            None => return Ok(None),
        }
    } else {
        None
    };
    let Some(confirmation) = input["confirmationId"].as_str() else { return Ok(None) };
    let Some(preview) = source_preview::peek(host, confirmation)? else { return Ok(None) };
    if preview["kind"] != kind || (has_source && preview["sourceId"] != input["sourceId"]) {
        return Ok(None);
    }
    let candidate = &preview["candidate"];
    let (Some(expected), Some(sent)) = (candidate["targets"].as_array(), input["targets"].as_array()) else { return Ok(None) };
    if sent.len() != expected.len() {
        return Ok(None);
    }
    let follows = follow_rows(host)?;
    let mut coverage = Vec::new();
    let mut versions = Vec::new();
    for (index, (one, want)) in sent.iter().zip(expected).enumerate() {
        let Some(entry) = exact(one, &["target", "targetUrl"]) else { return Ok(None) };
        let Some((label, version)) = target_label(&follows, teams, &entry["target"]) else { return Ok(None) };
        if entry["targetUrl"] != want["targetUrl"] || entry["target"] != want["target"] {
            return Ok(None);
        }
        coverage.push(field(&format!("Coverage {}", index + 1), &label));
        coverage.push(field(&format!("Source URL {}", index + 1), entry["targetUrl"].as_str().unwrap_or_default()));
        versions.push(version);
    }
    if input["authorizationAcknowledgement"] != ACKNOWLEDGEMENT
        || input["canonicalDomain"] != candidate["canonicalDomain"]
        || input["confirmedFetchHosts"] != candidate["confirmedFetchHosts"]
    {
        return Ok(None);
    }
    let candidate_label = candidate["label"].as_str().unwrap_or_default();
    let mut fields = Vec::new();
    if let Some((label, _)) = &source {
        fields.push(field("Source", label));
    }
    fields.push(field("Verified preview", candidate_label));
    fields.push(field("Authorization", ACKNOWLEDGEMENT));
    fields.push(field("Publisher", input["canonicalDomain"].as_str().unwrap_or_default()));
    match input["confirmedFetchHosts"].as_array().filter(|hosts| !hosts.is_empty()) {
        Some(hosts) => {
            for (index, host_name) in hosts.iter().enumerate() {
                fields.push(field(&format!("Allowed host {}", index + 1), host_name.as_str().unwrap_or_default()));
            }
        }
        None => fields.push(field("Allowed hosts", "None")),
    }
    if coverage.is_empty() {
        fields.push(field("Coverage", "No assignments"));
    } else {
        fields.extend(coverage);
    }
    if kind == "assignment-replacement" {
        fields.push(field("Effect", if sent.is_empty() { CLEARED } else { REPLACEMENT }));
    }
    let target = source.as_ref().map_or(candidate_label.to_owned(), |(label, _)| label.clone());
    let version = json!([confirmation, preview, source.map(|(_, v)| v), versions]);
    Ok(Some(json!({"title":title,"content":"outside","target":target,"fields":fields,"version":version.to_string()})))
}

/// The `prepareSportsSourceAction` public API. Known refusals use fixed text.
pub fn prepare<H: Host + ?Sized>(host: &H, teams: &dyn TeamList, tool: &str, input_json: &str) -> Value {
    if action(tool).is_none() {
        return json!({"error":{"statusCode":400,"error":"Unknown Sports tool"}});
    }
    let Ok(input) = serde_json::from_str::<Value>(input_json) else { return json!({"ok":null}) };
    match card(host, teams, tool, &input) {
        Ok(card) => json!({"ok":card}),
        Err(_) => json!({"error":{"statusCode":503,"error":"Sports service is unavailable"}}),
    }
}
