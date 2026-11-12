//! Rows the Mac link owns: connections, grants and start cancellations. Every read and write
//! goes through the typed query port in the call's own transaction, scoped to the signed-in
//! owner. JSON state lives in text columns, so state filters run here on bounded row sets.
use crate::capture_devices::{live, CONNECTION_PAGE};
use crate::capture_errors::{CaptureCode, Failure, Stop};
use crate::capture_selection::LEASE_MS;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Host,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const GRANTS: &str = "app.meeting_capture_grants";
pub const CONNECTIONS: &str = "app.meeting_capture_connections";
pub const CANCELLATIONS: &str = "app.meeting_capture_start_cancellations";
pub const LIMITS: &str = "app.meeting_capture_start_limits";
pub const CAPTURE: &str = "meetings.capture";
pub const PREVIOUS_GRANTS: u32 = 20;
const OPEN: [&str; 3] = ["approved", "active", "finalizing"];

pub fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

pub fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse(value: &Value) -> Option<DateTime<Utc>> {
    value.as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc))
}

pub fn now<H: Host + ?Sized>(host: &H) -> Result<DateTime<Utc>, Stop> {
    let context = host.call("context", "read", "call", json!({}))?;
    parse(&context["now"]).ok_or_else(|| Stop::Host(moss_module_sdk::Error::new("Invalid host time")))
}

/// The grant's stored state as JSON, or an empty object when none was saved.
pub fn state(grant: &Value) -> Value {
    grant["state_json"].as_str().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_else(|| json!({}))
}

pub fn new_id<H: Host + ?Sized>(host: &H) -> Result<String, Stop> {
    let made = host.call("context", "uuid", "new", json!({}))?;
    made["id"].as_str().map(str::to_owned).ok_or_else(|| Stop::Host(moss_module_sdk::Error::new("Invalid host id")))
}

fn one<H: Host + ?Sized>(host: &H, table: &str, filter: Filter) -> Result<Option<Value>, Stop> {
    let mut query = Query::select(filter);
    query.limit = Some(1);
    Ok(Client(host).query(table, &query)?.into_iter().next())
}

fn many<H: Host + ?Sized>(host: &H, table: &str, filter: Filter, limit: u32) -> Result<Vec<Value>, Stop> {
    let mut query = Query::select(filter);
    query.limit = Some(limit);
    Ok(Client(host).query(table, &query)?)
}

/// Serializes work per request key, per device or per meeting for the rest of this call.
/// The meeting lock also answers 404 when the meeting is not the owner's.
pub fn lock<H: Host + ?Sized>(host: &H, kind: &str, key: &str) -> Result<(), Stop> {
    let answer = host.call("kv", "lock", CAPTURE, json!({"kind": kind, "key": key}))?;
    if kind == "meeting" && answer["found"] != json!(true) {
        return Err(Failure::with_status(CaptureCode::Unavailable, 404).into());
    }
    Ok(())
}

pub fn connection<H: Host + ?Sized>(host: &H, device: &str) -> Result<Option<Value>, Stop> {
    one(host, CONNECTIONS, Filter::eq("device_id", device))
}

pub fn connections<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>, Stop> {
    let mut query = Query::select(Filter::All);
    query.order = vec![Order { column: "last_seen_at".into(), descending: true }];
    query.limit = Some(CONNECTION_PAGE as u32);
    Ok(Client(host).query(CONNECTIONS, &query)?)
}

pub struct Registration<'a> {
    pub device_id: &'a str,
    pub connection_id: &'a str,
    pub device_name: &'a str,
    pub verifier_hash: &'a str,
    pub capability_revision: i64,
    pub inventory: &'a Value,
    pub at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// Records a Mac connection. A new connection or capability revision revokes the device's
/// open grants. The same connection with a different verifier is a conflict.
pub fn register<H: Host + ?Sized>(host: &H, input: &Registration) -> Result<Value, Stop> {
    let current = connection(host, input.device_id)?;
    let same = current.as_ref().is_some_and(|c| c["connection_id"] == json!(input.connection_id));
    if same && current.as_ref().is_some_and(|c| c["verifier_hash"] != json!(input.verifier_hash)) {
        return Err(Failure::new(CaptureCode::Conflict).into());
    }
    if let Some(c) = &current {
        if !same || c["capability_revision"].as_i64() != Some(input.capability_revision) {
            revoke_open(host, input.device_id)?;
        }
    }
    let inventory = serde_json::to_string(input.inventory)?;
    let revision = match &current {
        Some(c) if same => {
            let unchanged = c["capability_revision"].as_i64() == Some(input.capability_revision) && c["inventory_json"].as_str() == Some(inventory.as_str());
            c["revision"].as_i64().unwrap_or(0) + if unchanged { 0 } else { 1 }
        }
        _ => 1,
    };
    let fields = vec![
        ("connection_id", json!(input.connection_id)),
        ("device_name", json!(input.device_name)),
        ("verifier_hash", json!(input.verifier_hash)),
        ("capability_revision", json!(input.capability_revision)),
        ("revision", json!(revision)),
        ("inventory_json", json!(inventory)),
        ("last_seen_at", json!(stamp(input.at))),
        ("expires_at", json!(stamp(input.expires_at))),
    ];
    let mut insert_values = fields.clone();
    insert_values.push(("device_id", json!(input.device_id)));
    let mut upsert = Query::insert(values(insert_values));
    upsert.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into(), "device_id".into()],
        values: values(fields),
    };
    Client(host).query(CONNECTIONS, &upsert)?.into_iter().next().ok_or_else(|| Stop::Host(moss_module_sdk::Error::new("Connection not saved")))
}

/// Revokes every grant on the device that is not already finished.
pub fn revoke_open<H: Host + ?Sized>(host: &H, device: &str) -> Result<(), Stop> {
    let filter = Filter::And {
        filters: vec![
            Filter::eq("device_id", device),
            Filter::Compare { column: "status".into(), op: moss_module_sdk::query::Compare::Ne, value: json!("revoked") },
            Filter::Compare { column: "status".into(), op: moss_module_sdk::query::Compare::Ne, value: json!("complete") },
        ],
    };
    Client(host).query(GRANTS, &Query::update(filter, values(vec![("status", json!("revoked"))])))?;
    Ok(())
}

pub fn set_status<H: Host + ?Sized>(host: &H, grant: &str, status: &str) -> Result<(), Stop> {
    Client(host).query(GRANTS, &Query::update(Filter::eq("id", grant), values(vec![("status", json!(status))])))?;
    Ok(())
}

pub fn grants_for_device<H: Host + ?Sized>(host: &H, device: &str) -> Result<Vec<Value>, Stop> {
    many(host, GRANTS, Filter::eq("device_id", device), 1000)
}

pub fn grants_for_meeting<H: Host + ?Sized>(host: &H, meeting: &str) -> Result<Vec<Value>, Stop> {
    many(host, GRANTS, Filter::eq("meeting_id", meeting), PREVIOUS_GRANTS + 1)
}

pub fn grant<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>, Stop> {
    one(host, GRANTS, Filter::eq("id", id))
}

pub fn by_request<H: Host + ?Sized>(host: &H, request_key: &str) -> Result<Option<Value>, Stop> {
    one(host, GRANTS, Filter::eq("start_request_key", request_key))
}

fn expired(grant: &Value, key: &str, at: DateTime<Utc>) -> bool {
    parse(&grant[key]).is_some_and(|t| t <= at)
}

/// Settles the device's grants the way a start does before it looks for a conflict. A grant
/// whose Mac went silent is ended. Expired and unclaimed grants are revoked. A stopped grant
/// past its deadline is complete.
pub fn retire<H: Host + ?Sized>(host: &H, device: &str, at: DateTime<Utc>) -> Result<(), Stop> {
    for grant in grants_for_device(host, device)? {
        let status = grant["status"].as_str().unwrap_or_default().to_owned();
        if status == "revoked" || status == "complete" {
            continue;
        }
        let id = grant["id"].as_str().unwrap_or_default().to_owned();
        let mut saved = state(&grant);
        let desired = saved["desired"].as_str().unwrap_or_default().to_owned();
        let seen = parse(&saved["lastSeenAt"]).or_else(|| parse(&saved["originAt"]));
        if status == "active" && desired != "stopped" && seen.is_some_and(|s| s <= at - Duration::milliseconds(LEASE_MS)) {
            let ids = [new_id(host)?, new_id(host)?];
            crate::capture_state::expire_lease(&mut saved, at, parse(&grant["expires_at"]), &ids);
            saved["desired"] = json!("revoked");
            save(host, &grant, &saved)?;
            continue;
        }
        let unclaimed = status == "approved" && desired != "paused" && expired(&grant, "claim_expires_at", at);
        if expired(&grant, "expires_at", at) || unclaimed {
            set_status(host, &id, "revoked")?;
        } else if (status == "active" || status == "finalizing") && desired == "stopped" && expired(&saved, "finalizationDeadline", at) {
            set_status(host, &id, "complete")?;
        }
    }
    Ok(())
}

/// Writes a grant's state, deriving the status the legacy store derived.
pub fn save<H: Host + ?Sized>(host: &H, grant: &Value, saved: &Value) -> Result<(), Stop> {
    let text = serde_json::to_string(saved)?;
    if text.len() > 500_000 {
        return Err(Failure::new(CaptureCode::Limit).into());
    }
    let status = match saved["desired"].as_str() {
        Some("revoked") => "revoked",
        Some("stopped") if saved["finalized"] == json!(true) => "complete",
        Some("stopped") => "finalizing",
        _ => grant["status"].as_str().unwrap_or("approved"),
    };
    let id = grant["id"].as_str().unwrap_or_default();
    Client(host).query(
        GRANTS,
        &Query::update(Filter::eq("id", id), values(vec![("state_json", json!(text)), ("status", json!(status))])),
    )?;
    Ok(())
}

/// True when the Mac still holds a grant for this connection.
pub fn occupied<H: Host + ?Sized>(host: &H, device: &str, connection_id: &str) -> Result<bool, Stop> {
    Ok(grants_for_device(host, device)?
        .iter()
        .any(|g| g["connection_id"] == json!(connection_id) && OPEN.contains(&g["status"].as_str().unwrap_or_default())))
}

/// The newest open grant that still holds the Mac at `at`.
pub fn occupying<H: Host + ?Sized>(host: &H, connection: &Value, at: DateTime<Utc>) -> Result<Option<Value>, Stop> {
    let mut held: Vec<Value> = grants_for_device(host, connection["device_id"].as_str().unwrap_or_default())?
        .into_iter()
        .filter(|g| {
            let saved = state(g);
            let desired = saved["desired"].as_str().unwrap_or_default();
            g["connection_id"] == connection["connection_id"]
                && OPEN.contains(&g["status"].as_str().unwrap_or_default())
                && parse(&g["expires_at"]).is_some_and(|t| t > at)
                && (g["status"] != "approved" || desired == "paused" || parse(&g["claim_expires_at"]).is_some_and(|t| t > at))
                && (desired != "stopped" || parse(&saved["finalizationDeadline"]).is_some_and(|t| t > at))
        })
        .collect();
    held.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
    Ok(held.into_iter().next())
}

/// The approved grant a Mac should claim next, oldest first.
pub fn command<H: Host + ?Sized>(host: &H, connection: &Value, at: DateTime<Utc>) -> Result<Option<Value>, Stop> {
    let mut ready: Vec<Value> = grants_for_device(host, connection["device_id"].as_str().unwrap_or_default())?
        .into_iter()
        .filter(|g| {
            g["connection_id"] == connection["connection_id"]
                && g["capability_revision"] == connection["capability_revision"]
                && g["status"] == "approved"
                && state(g)["desired"] == "recording"
                && parse(&g["claim_expires_at"]).is_some_and(|t| t > at)
                && parse(&g["expires_at"]).is_some_and(|t| t > at)
        })
        .collect();
    ready.sort_by(|a, b| a["created_at"].as_str().cmp(&b["created_at"].as_str()));
    Ok(ready.into_iter().next())
}

pub struct NewGrant<'a> {
    pub meeting_id: &'a str,
    pub session_id: &'a str,
    pub connection: &'a Value,
    pub request_key: &'a str,
    pub fingerprint: &'a str,
    pub expires_at: DateTime<Utc>,
    pub claim_expires_at: DateTime<Utc>,
    pub state: &'a Value,
}

pub fn create<H: Host + ?Sized>(host: &H, input: &NewGrant) -> Result<Value, Stop> {
    let c = input.connection;
    let insert = Query::insert(values(vec![
        ("meeting_id", json!(input.meeting_id)),
        ("device_id", c["device_id"].clone()),
        ("device_name", c["device_name"].clone()),
        ("verifier_hash", c["verifier_hash"].clone()),
        ("session_id", json!(input.session_id)),
        ("status", json!("approved")),
        ("expires_at", json!(stamp(input.expires_at))),
        ("state_json", json!(serde_json::to_string(input.state)?)),
        ("connection_id", c["connection_id"].clone()),
        ("capability_revision", c["capability_revision"].clone()),
        ("claim_expires_at", json!(stamp(input.claim_expires_at))),
        ("start_request_key", json!(input.request_key)),
        ("start_fingerprint", json!(input.fingerprint)),
    ]));
    Client(host).query(GRANTS, &insert)?.into_iter().next().ok_or_else(|| Stop::Host(moss_module_sdk::Error::new("Grant not saved")))
}

pub fn cancelled<H: Host + ?Sized>(host: &H, request_key: &str) -> Result<bool, Stop> {
    Ok(one(host, CANCELLATIONS, Filter::eq("request_key", request_key))?.is_some())
}

pub fn is_live(connection: &Value, at: DateTime<Utc>) -> bool {
    live(connection, at)
}
