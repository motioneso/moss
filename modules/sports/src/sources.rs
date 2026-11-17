//! Saved added sources and the targets each one covers. Every read and write runs as the
//! signed-in person under row level security, so one person's sources never reach another.
use crate::source_discovery::{Candidate, Verified};
use crate::source_scope::Target;
use crate::util::{iso, iso_or_null, values};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

pub const SOURCES: &str = "app.sports_custom_sources";
pub const ASSIGNMENTS: &str = "app.sports_source_assignments";
pub const MAX_CUSTOM_SOURCES: usize = 10;

fn bad() -> Error {
    Error::new("Invalid source row")
}

fn oldest_first() -> Vec<Order> {
    vec![Order { column: "created_at".into(), descending: false }, Order { column: "id".into(), descending: false }]
}

/// What the status line says about photos, worked out from the stored record.
fn photo_status(row: &Value) -> &'static str {
    let state = row["photo_rule_state"].as_str().unwrap_or("none");
    if state == "previewing" {
        return "previewing";
    }
    if state == "stale" && !row["photo_relook_at"].is_null() {
        return "stopped_working";
    }
    match row["photo_last_outcome"].as_str() {
        None => "pending",
        Some("working") => "working",
        Some(_) => "none",
    }
}

fn photos_found_by_moss(row: &Value) -> bool {
    !row["photo_rule_json"].is_null() && matches!(row["photo_rule_state"].as_str(), Some("in_use") | Some("stale"))
}

fn maybe(row: &Value, key: &str) -> Value {
    row[key].as_str().map(|t| Value::String(t.to_owned())).unwrap_or(Value::Null)
}

pub fn assignment_dto(row: &Value) -> Result<Value> {
    Ok(json!({
        "id": row["id"].as_str().ok_or_else(bad)?,
        "followId": maybe(row, "follow_id"),
        "sportKey": maybe(row, "sport_key"),
        "targetUrl": maybe(row, "target_url"),
        "previewStatus": row["preview_status"].as_str().ok_or_else(bad)?,
        "healthState": row["health_state"].as_str().ok_or_else(bad)?,
        "healthReasonCode": maybe(row, "health_reason_code"),
        "healthMessage": maybe(row, "health_message"),
        "lastCheckedAt": iso_or_null(&row["last_checked_at"])?,
        "lastSuccessAt": iso_or_null(&row["last_success_at"])?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

pub fn source_dto(row: &Value, assignments: &[Value]) -> Result<Value> {
    let dtos = assignments.iter().map(assignment_dto).collect::<Result<Vec<_>>>()?;
    let followed: Vec<Value> = dtos.iter().filter(|a| !a["followId"].is_null()).map(|a| a["followId"].clone()).collect();
    Ok(json!({
        "id": row["id"].as_str().ok_or_else(bad)?,
        "label": row["label"].as_str().ok_or_else(bad)?,
        "canonicalDomain": row["canonical_domain"].as_str().ok_or_else(bad)?,
        "homepageUrl": row["homepage_url"].as_str().ok_or_else(bad)?,
        "feedUrl": maybe(row, "feed_url"),
        "retrievalMethod": row["retrieval_method"].as_str().ok_or_else(bad)?,
        "enabled": row["enabled"].as_bool().ok_or_else(bad)?,
        "healthState": row["health_state"].as_str().ok_or_else(bad)?,
        "healthReasonCode": maybe(row, "health_reason_code"),
        "healthMessage": maybe(row, "health_message"),
        "lastCheckedAt": iso_or_null(&row["last_checked_at"])?,
        "lastSuccessAt": iso_or_null(&row["last_success_at"])?,
        "recipeStatus": row["recipe_status"].as_str().ok_or_else(bad)?,
        "photoStatus": photo_status(row),
        "photosFoundByMoss": photos_found_by_moss(row),
        "assignedFollowIds": followed,
        "assignments": dtos,
        "createdAt": iso(&row["created_at"])?,
    }))
}

/// The key two saved sources are compared on. Publications collide on domain; two subreddits
/// collide on their lower-cased name, so r/nfl and r/NFL are one source.
pub fn identity_key(method: &str, domain: &str, feed_url: Option<&str>, homepage_url: Option<&str>) -> String {
    if method == "reddit" {
        let name = moss_news_reader::subreddit_name_from_url(feed_url).or_else(|| moss_news_reader::subreddit_name_from_url(homepage_url));
        if let Some(name) = name {
            return format!("reddit:{}", name.to_lowercase());
        }
    }
    format!("domain:{domain}")
}

pub fn row_identity_key(row: &Value) -> String {
    identity_key(
        row["retrieval_method"].as_str().unwrap_or_default(),
        row["canonical_domain"].as_str().unwrap_or_default(),
        row["feed_url"].as_str(),
        row["homepage_url"].as_str(),
    )
}

pub fn candidate_identity_key(candidate: &Candidate) -> String {
    identity_key(&candidate.retrieval_method, &candidate.canonical_domain, Some(&candidate.feed_url), Some(&candidate.homepage_url))
}

/// Every source row with the assignment rows of each, newest source first.
pub fn rows<H: Host + ?Sized>(host: &H) -> Result<Vec<(Value, Vec<Value>)>> {
    let client = Client(host);
    let mut sources = Query::select(Filter::All);
    sources.order = vec![Order { column: "created_at".into(), descending: true }, Order { column: "id".into(), descending: false }];
    let sources = client.query(SOURCES, &sources)?;
    let mut assignments = Query::select(Filter::All);
    assignments.order = oldest_first();
    let assignments = client.query(ASSIGNMENTS, &assignments)?;
    Ok(sources
        .into_iter()
        .map(|source| {
            let own = assignments.iter().filter(|a| a["source_id"] == source["id"]).cloned().collect();
            (source, own)
        })
        .collect())
}

pub fn list<H: Host + ?Sized>(host: &H) -> Result<Vec<Value>> {
    rows(host)?.iter().map(|(source, own)| source_dto(source, own)).collect()
}

pub fn count_assignments<H: Host + ?Sized>(host: &H) -> Result<usize> {
    Ok(Client(host).query(ASSIGNMENTS, &Query::select(Filter::All))?.len())
}

pub fn find<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<(Value, Vec<Value>)>> {
    let client = Client(host);
    let mut one = Query::select(Filter::eq("id", id));
    one.limit = Some(1);
    let Some(source) = client.query(SOURCES, &one)?.into_iter().next() else { return Ok(None) };
    let mut own = Query::select(Filter::eq("source_id", id));
    own.order = oldest_first();
    Ok(Some((source, client.query(ASSIGNMENTS, &own)?)))
}

/// A source as the preview saw it, so a confirm can tell whether anything moved in between.
pub fn baseline<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<Value>> {
    let Some((source, own)) = find(host, id)? else { return Ok(None) };
    let assignments: Vec<Value> = own
        .iter()
        .map(|a| {
            json!({
                "id": a["id"], "followId": a["follow_id"], "sportKey": a["sport_key"], "targetUrl": a["target_url"],
                "parameters": a["target_parameters"], "previewStatus": a["preview_status"],
            })
        })
        .collect();
    Ok(Some(json!({
        "source": source_dto(&source, &own)?,
        "validationFingerprint": source["validation_fingerprint"],
        "recipeFingerprint": source["recipe_fingerprint"],
        "recipeJson": source["recipe_json"],
        "confirmedFetchHosts": source["confirmed_fetch_hosts"],
        "updatedAt": iso(&source["updated_at"])?,
        "assignments": assignments,
    })))
}

/// The follows the person actually owns, among those named. Row level security hides the rest.
fn owned_follow_count<H: Host + ?Sized>(host: &H, ids: &[String]) -> Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let filter = Filter::In { column: "id".into(), values: ids.iter().map(|id| json!(id)).collect() };
    Ok(Client(host).query("app.sports_follows", &Query::select(filter))?.len())
}

fn follow_ids(targets: &[Target]) -> Vec<String> {
    targets.iter().filter_map(|t| if let Target::Follow(id) = t { Some(id.clone()) } else { None }).collect()
}

fn assignment_row(source_id: &str, verified: &Verified) -> Result<std::collections::BTreeMap<String, Value>> {
    let target = Target::from_json(&verified.target).ok_or_else(|| Error::new("Invalid target"))?;
    let (follow, sport) = match &target {
        Target::Follow(id) => (json!(id), Value::Null),
        Target::Sport(key) => (Value::Null, json!(key)),
    };
    Ok(values(vec![
        ("source_id", json!(source_id)),
        ("follow_id", follow),
        ("sport_key", sport),
        ("target_url", json!(verified.target_url)),
        ("target_parameters", verified.parameters.clone()),
        ("preview_status", json!("verified")),
        ("health_state", json!("healthy")),
        ("health_reason_code", Value::Null),
        ("health_message", Value::Null),
        ("last_checked_at", json!(verified.checked_at)),
        ("last_success_at", json!(verified.checked_at)),
    ]))
}

pub enum Created {
    Source(Value),
    LimitExceeded,
}

/// Saves a confirmed source and its targets. A source the person already has comes back as is.
pub fn create<H: Host + ?Sized>(host: &H, candidate: &Candidate, now: &str) -> Result<Created> {
    let client = Client(host);
    if client.query(SOURCES, &Query::select(Filter::All))?.len() >= MAX_CUSTOM_SOURCES {
        return Ok(Created::LimitExceeded);
    }
    let targets: Vec<Target> = candidate.targets.iter().filter_map(|t| Target::from_json(&t.target)).collect();
    if targets.len() != candidate.targets.len() || !crate::source_scope::has_valid_targets(&targets) {
        return Err(Error::new("Sports source preview contains invalid targets"));
    }
    let follows = follow_ids(&targets);
    if owned_follow_count(host, &follows)? != follows.len() {
        return Err(Error::new("Sports source preview contains an unavailable follow"));
    }
    let reddit = candidate.retrieval_method == "reddit";
    let scrape = candidate.retrieval_method == "scrape";
    if scrape && (candidate.recipe.is_none() || candidate.recipe_fingerprint.is_none()) {
        return Err(Error::new("Sports source preview is missing its recipe"));
    }
    let mut insert = Query::insert(values(vec![
        ("label", json!(candidate.label)),
        ("canonical_domain", json!(candidate.canonical_domain)),
        ("homepage_url", json!(candidate.homepage_url)),
        ("feed_url", if scrape { Value::Null } else { json!(candidate.feed_url) }),
        ("retrieval_method", json!(candidate.retrieval_method)),
        ("validation_fingerprint", json!(candidate.validation_fingerprint)),
        ("validated_at", json!(now)),
        ("recipe_json", if scrape { candidate.recipe.clone().unwrap_or(Value::Null) } else { Value::Null }),
        ("recipe_schema_version", if scrape { json!(1) } else { Value::Null }),
        ("recipe_fingerprint", if scrape { json!(candidate.recipe_fingerprint) } else { Value::Null }),
        ("recipe_status", json!(if scrape { "ready" } else { "feed" })),
        ("icon_url", if reddit { json!(candidate.icon_url) } else { Value::Null }),
        ("confirmed_fetch_hosts", json!(candidate.confirmed_fetch_hosts)),
        ("authorization_confirmed_at", json!(now)),
        ("health_state", json!("healthy")),
        ("health_reason_code", Value::Null),
        ("health_message", Value::Null),
        ("last_checked_at", json!(candidate.checked_at)),
        ("last_success_at", json!(candidate.checked_at)),
    ]));
    insert.conflict = Conflict::Ignore;
    let Some(row) = client.query(SOURCES, &insert)?.into_iter().next() else {
        // A collision on the unique index: the source is already saved.
        let key = candidate_identity_key(candidate);
        let existing = rows(host)?.into_iter().find(|(source, _)| row_identity_key(source) == key);
        return match existing {
            Some((source, own)) => Ok(Created::Source(source_dto(&source, &own)?)),
            None => Err(Error::new("Source could not be saved")),
        };
    };
    let id = row["id"].as_str().ok_or_else(bad)?.to_owned();
    for verified in &candidate.targets {
        if let Err(error) = client.query(ASSIGNMENTS, &Query::insert(assignment_row(&id, verified)?)) {
            // Removing the source removes whatever targets were saved, so no half source stays.
            let _ = client.query(SOURCES, &Query::delete(Filter::eq("id", id.as_str())));
            return Err(error);
        }
    }
    let (source, own) = find(host, &id)?.ok_or_else(bad)?;
    Ok(Created::Source(source_dto(&source, &own)?))
}

/// The state a source shows once its targets change: the newest check across the targets, and
/// one health that summarises them.
pub fn aggregate_health(enabled: bool, assignments: &[Value]) -> Value {
    let state = |a: &Value| a["health_state"].as_str().unwrap_or("pending").to_owned();
    let none = json!({"health_state": if enabled { "healthy" } else { "disabled" }, "health_reason_code": null, "health_message": null});
    if !enabled {
        return none;
    }
    if assignments.iter().any(|a| state(a) == "pending") {
        return json!({"health_state":"pending","health_reason_code":null,"health_message":null});
    }
    if assignments.iter().all(|a| state(a) == "healthy") {
        return none;
    }
    let first = &assignments[0];
    let head = state(first);
    if (head == "unsupported" || head == "auth_required") && assignments.iter().all(|a| state(a) == head) {
        return json!({"health_state":head,"health_reason_code":first["health_reason_code"],"health_message":first["health_message"]});
    }
    if head == "failing" && assignments.iter().all(|a| state(a) == "failing" && a["health_reason_code"] == first["health_reason_code"]) {
        return json!({"health_state":"failing","health_reason_code":first["health_reason_code"],"health_message":first["health_message"]});
    }
    json!({"health_state":"failing","health_reason_code":"partial_target_failure","health_message":"Some source targets could not be refreshed."})
}

pub fn newest(assignments: &[Value], key: &str) -> Value {
    assignments.iter().filter_map(|a| a[key].as_str()).max().map(|t| json!(t)).unwrap_or(Value::Null)
}

/// Replaces a source's targets with the checked ones, keeping the rows the preview reused.
pub fn replace_assignments<H: Host + ?Sized>(host: &H, source_id: &str, reused: &[String], verified: &[Verified]) -> Result<Option<Value>> {
    let targets: Vec<Target> = verified.iter().filter_map(|t| Target::from_json(&t.target)).collect();
    if targets.len() != verified.len() || !crate::source_scope::has_valid_targets(&targets) {
        return Err(Error::new("Sports assignment preview contains invalid targets"));
    }
    let Some((source, current)) = find(host, source_id)? else { return Ok(None) };
    let follows = follow_ids(&targets);
    if owned_follow_count(host, &follows)? != follows.len() {
        return Err(Error::new("Sports assignment preview contains an unavailable follow"));
    }
    let client = Client(host);
    for old in &current {
        let id = old["id"].as_str().ok_or_else(bad)?;
        if !reused.iter().any(|r| r == id) {
            client.query(ASSIGNMENTS, &Query::delete(Filter::eq("id", id)))?;
        }
    }
    for item in verified {
        client.query(ASSIGNMENTS, &Query::insert(assignment_row(source_id, item)?))?;
    }
    let mut own = Query::select(Filter::eq("source_id", source_id));
    own.order = oldest_first();
    let assignments = client.query(ASSIGNMENTS, &own)?;
    let update = if assignments.is_empty() {
        // Nothing to summarise, so only the change time moves.
        values(vec![("updated_at", json!(crate::source_discovery::iso_now(host)?))])
    } else {
        let health = aggregate_health(source["enabled"].as_bool().unwrap_or(true), &assignments);
        values(vec![
            ("health_state", health["health_state"].clone()),
            ("health_reason_code", health["health_reason_code"].clone()),
            ("health_message", health["health_message"].clone()),
            ("last_checked_at", newest(&assignments, "last_checked_at")),
            ("last_success_at", newest(&assignments, "last_success_at")),
        ])
    };
    let updated = client.query(SOURCES, &Query::update(Filter::eq("id", source_id), update))?;
    let row = updated.into_iter().next().ok_or_else(bad)?;
    Ok(Some(source_dto(&row, &assignments)?))
}

pub fn remove<H: Host + ?Sized>(host: &H, id: &str) -> Result<bool> {
    Ok(!Client(host).query(SOURCES, &Query::delete(Filter::eq("id", id)))?.is_empty())
}

/// The saved address of a source's icon, for the icon route.
pub fn icon_record<H: Host + ?Sized>(host: &H, id: &str) -> Result<Option<(String, Option<String>)>> {
    let Some((source, _)) = find(host, id)? else { return Ok(None) };
    let domain = source["canonical_domain"].as_str().ok_or_else(bad)?.to_owned();
    Ok(Some((domain, source["icon_url"].as_str().map(str::to_owned))))
}

/// Writes one target's health after a refresh. Only a row that still holds the address that was
/// read is touched, so a target replaced meanwhile keeps its own state.
pub fn write_assignment_health<H: Host + ?Sized>(
    host: &H,
    id: &str,
    target_url: &str,
    state: &str,
    reason: Option<&str>,
    message: Option<&str>,
    checked_at: &str,
) -> Result<()> {
    let mut changes = vec![
        ("health_state", json!(state)),
        ("health_reason_code", json!(reason)),
        ("health_message", json!(message)),
        ("last_checked_at", json!(checked_at)),
    ];
    if state == "healthy" {
        changes.push(("last_success_at", json!(checked_at)));
    }
    let filter = Filter::And { filters: vec![Filter::eq("id", id), Filter::eq("target_url", target_url)] };
    Client(host).query(ASSIGNMENTS, &Query::update(filter, values(changes)))?;
    Ok(())
}

/// Recomputes a source's health from its targets. `recipe_status` moves only for a site source.
pub fn recompute_health<H: Host + ?Sized>(host: &H, source_id: &str, recipe_status: Option<&str>) -> Result<()> {
    let Some((source, assignments)) = find(host, source_id)? else { return Ok(()) };
    if assignments.is_empty() {
        return Ok(());
    }
    let health = aggregate_health(source["enabled"].as_bool().unwrap_or(true), &assignments);
    let mut changes = vec![
        ("health_state", health["health_state"].clone()),
        ("health_reason_code", health["health_reason_code"].clone()),
        ("health_message", health["health_message"].clone()),
        ("last_checked_at", newest(&assignments, "last_checked_at")),
        ("last_success_at", newest(&assignments, "last_success_at")),
    ];
    if let Some(status) = recipe_status {
        changes.push(("recipe_status", json!(status)));
    }
    Client(host).query(SOURCES, &Query::update(Filter::eq("id", source_id), values(changes)))?;
    Ok(())
}

/// Replaces a source's recipe and targets with a rebuilt, replayed candidate.
pub fn replace_recipe<H: Host + ?Sized>(host: &H, id: &str, candidate: &Candidate, now: &str) -> Result<Option<Value>> {
    let targets: Vec<Target> = candidate.targets.iter().filter_map(|t| Target::from_json(&t.target)).collect();
    if targets.len() != candidate.targets.len() || !crate::source_scope::has_valid_targets(&targets) {
        return Err(Error::new("Sports source preview contains invalid targets"));
    }
    let Some((_, current)) = find(host, id)? else { return Ok(None) };
    let follows = follow_ids(&targets);
    if owned_follow_count(host, &follows)? != follows.len() {
        return Err(Error::new("Sports source preview contains an unavailable follow"));
    }
    let scrape = candidate.retrieval_method == "scrape";
    let client = Client(host);
    let update = values(vec![
        ("label", json!(candidate.label)),
        ("canonical_domain", json!(candidate.canonical_domain)),
        ("homepage_url", json!(candidate.homepage_url)),
        ("feed_url", if scrape { Value::Null } else { json!(candidate.feed_url) }),
        ("retrieval_method", json!(candidate.retrieval_method)),
        ("validation_fingerprint", json!(candidate.validation_fingerprint)),
        ("validated_at", json!(now)),
        ("recipe_json", if scrape { candidate.recipe.clone().unwrap_or(Value::Null) } else { Value::Null }),
        ("recipe_schema_version", if scrape { json!(1) } else { Value::Null }),
        ("recipe_fingerprint", if scrape { json!(candidate.recipe_fingerprint) } else { Value::Null }),
        ("recipe_status", json!(if scrape { "ready" } else { "feed" })),
        ("confirmed_fetch_hosts", json!(candidate.confirmed_fetch_hosts)),
        ("authorization_confirmed_at", json!(now)),
        ("health_state", json!("healthy")),
        ("health_reason_code", Value::Null),
        ("health_message", Value::Null),
        ("last_checked_at", json!(candidate.checked_at)),
        ("last_success_at", json!(candidate.checked_at)),
    ]);
    // Not atomic. The host offers no transaction to this package, so a failure after the delete
    // can leave the new recipe with no targets.
    let updated = client.query(SOURCES, &Query::update(Filter::eq("id", id), update))?;
    let row = updated.into_iter().next().ok_or_else(bad)?;
    for old in &current {
        client.query(ASSIGNMENTS, &Query::delete(Filter::eq("id", old["id"].as_str().ok_or_else(bad)?)))?;
    }
    for item in &candidate.targets {
        client.query(ASSIGNMENTS, &Query::insert(assignment_row(id, item)?))?;
    }
    let own = find(host, id)?.map(|(_, a)| a).unwrap_or_default();
    Ok(Some(source_dto(&row, &own)?))
}
