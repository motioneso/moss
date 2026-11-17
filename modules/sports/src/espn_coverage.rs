//! Which sports and followed teams ESPN headlines cover. A person with no choices gets the
//! default coverage, and saving an empty list turns ESPN headlines off.
use crate::source_scope::Target;
use crate::source_discovery::iso_now;
use crate::util::values;
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

const PREFS: &str = "app.sports_headline_prefs";
const ASSIGNMENTS: &str = "app.sports_espn_source_assignments";

/// The built-in source as the source list shows it.
pub fn get<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let client = Client(host);
    let mut pref = Query::select(Filter::All);
    pref.limit = Some(1);
    let enabled = client
        .query(PREFS, &pref)?
        .first()
        .and_then(|row| row["espn_headlines_enabled"].as_bool())
        .unwrap_or(true);
    let mut own = Query::select(Filter::All);
    own.order = vec![
        Order { column: "created_at".into(), descending: false },
        Order { column: "id".into(), descending: false },
    ];
    let mut targets = Vec::new();
    for row in client.query(ASSIGNMENTS, &own)? {
        let target = match (row["sport_key"].as_str(), row["follow_id"].as_str()) {
            (Some(key), _) if crate::source_scope::is_sport_key(key) => Target::Sport(key.to_owned()),
            (Some(_), _) => return Err(Error::new("Unknown ESPN sports coverage key")),
            (None, Some(id)) => Target::Follow(id.to_owned()),
            (None, None) => return Err(Error::new("ESPN coverage row has no target")),
        };
        targets.push(target.to_json());
    }
    Ok(json!({
        "kind": "builtin",
        "id": "espn",
        "label": "ESPN",
        "enabled": enabled,
        "usesDefaultCoverage": enabled && targets.is_empty(),
        "assignments": targets,
    }))
}

/// Replaces the coverage. The caller has already checked the targets and the follows.
pub fn replace<H: Host + ?Sized>(host: &H, targets: &[Target]) -> Result<Value> {
    let client = Client(host);
    for row in client.query(ASSIGNMENTS, &Query::select(Filter::All))? {
        let id = row["id"].as_str().ok_or_else(|| Error::new("Invalid coverage row"))?;
        client.query(ASSIGNMENTS, &Query::delete(Filter::eq("id", id)))?;
    }
    let now = iso_now(host)?;
    let enabled = !targets.is_empty();
    let mut pref = Query::insert(values(vec![("espn_headlines_enabled", json!(enabled)), ("updated_at", json!(now))]));
    pref.conflict = Conflict::Update {
        columns: vec!["owner_user_id".into()],
        values: values(vec![("espn_headlines_enabled", json!(enabled)), ("updated_at", json!(now))]),
    };
    client.query(PREFS, &pref)?;
    for target in targets {
        let (sport, follow) = match target {
            Target::Sport(key) => (json!(key), Value::Null),
            Target::Follow(id) => (Value::Null, json!(id)),
        };
        client.query(ASSIGNMENTS, &Query::insert(values(vec![("sport_key", sport), ("follow_id", follow)])))?;
    }
    get(host)
}
