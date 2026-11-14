//! Added sources, topics, excluded publishers and the read behind the personalization screen.
//! Refresh state is read here and written only by the refresh job.
use crate::util::{bad_request, error, id_param, iso, iso_or_null, js_trim, values};
use crate::{domain, input};
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Value};

pub const SOURCES: &str = "app.news_custom_sources";
pub const TOPICS: &str = "app.news_custom_topics";
pub const EXCLUSIONS: &str = "app.news_source_exclusions";
pub const SNAPSHOTS: &str = "app.news_compilation_snapshots";
pub const REFRESH: &str = "app.news_refresh_state";
pub const POLICY: &str = "app.news_policy_verdicts";
const EXCLUSION_LIMIT: usize = 100;

fn text<'a>(row: &'a Value, key: &str) -> Result<&'a str> {
    row[key].as_str().ok_or_else(|| Error::new("Invalid news row"))
}

fn newest_first() -> Vec<Order> {
    vec![
        Order { column: "created_at".into(), descending: true },
        Order { column: "id".into(), descending: false },
    ]
}

pub(crate) fn source_dto(row: &Value) -> Result<Value> {
    let method = text(row, "retrieval_method")?;
    let feed = row["feed_url"].as_str();
    let canonical = text(row, "canonical_domain")?;
    Ok(json!({
        "id": text(row, "id")?,
        "label": text(row, "label")?,
        "canonicalDomain": canonical,
        "homepageUrl": text(row, "homepage_url")?,
        "feedUrl": feed,
        "retrievalMethod": method,
        "workaround": method == "feed" && domain::is_workaround(canonical, feed),
        "validationStatus": text(row, "validation_status")?,
        "healthStatus": text(row, "health_status")?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

fn topic_dto(row: &Value) -> Result<Value> {
    Ok(json!({
        "id": text(row, "id")?,
        "label": text(row, "label")?,
        "guidance": row["guidance"],
        "validationStatus": text(row, "validation_status")?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

fn exclusion_dto(row: &Value) -> Result<Value> {
    Ok(json!({
        "id": text(row, "id")?,
        "canonicalDomain": text(row, "canonical_domain")?,
        "createdAt": iso(&row["created_at"])?,
    }))
}

fn list<H: Host + ?Sized>(host: &H, table: &str) -> Result<Vec<Value>> {
    let mut query = Query::select(Filter::All);
    query.order = newest_first();
    Client(host).query(table, &query)
}

/// The saved feed's dates and article count. The package never changes the saved feed.
fn snapshot_meta(row: Option<&Value>) -> Result<Value> {
    let Some(row) = row else { return Ok(Value::Null) };
    let count = row["payload"]["articles"].as_array().map(Vec::len).unwrap_or(0);
    Ok(json!({
        "compiledAt": iso(&row["compiled_at"])?,
        "expiresAt": iso(&row["expires_at"])?,
        "articleCount": count,
    }))
}

fn refresh_dto(row: Option<&Value>) -> Result<Value> {
    let Some(row) = row else {
        return Ok(json!({
            "state": "idle", "updatedAt": null, "lastRequestedAt": null, "lastAttemptAt": null,
            "lastSuccessAt": null, "lastFailureAt": null, "lastFailureKind": null,
        }));
    };
    let mut out = json!({
        "state": text(row, "state")?,
        "updatedAt": iso(&row["updated_at"])?,
    });
    if let Some(kind) = row["failure_kind"].as_str() {
        out["failureKind"] = json!(kind);
    }
    out["lastRequestedAt"] = iso_or_null(&row["last_requested_at"])?;
    out["lastAttemptAt"] = iso_or_null(&row["last_attempt_at"])?;
    out["lastSuccessAt"] = iso_or_null(&row["last_success_at"])?;
    out["lastFailureAt"] = iso_or_null(&row["last_failure_at"])?;
    out["lastFailureKind"] = row["last_failure_kind"].clone();
    Ok(out)
}

/// `GET /personalization`. Adding by address is on. The host cannot say whether a model is set up,
/// so that flag is always on and a missing model shows when a preview is tried. Name search and
/// free-form topics need web search and stay off.
pub fn get<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let client = Client(host);
    let sources = list(host, SOURCES)?.iter().map(source_dto).collect::<Result<Vec<_>>>()?;
    let topics = list(host, TOPICS)?.iter().map(topic_dto).collect::<Result<Vec<_>>>()?;
    let exclusions = list(host, EXCLUSIONS)?.iter().map(exclusion_dto).collect::<Result<Vec<_>>>()?;
    let snapshot = client.query(SNAPSHOTS, &Query::select(Filter::All))?;
    let refresh = client.query(REFRESH, &Query::select(Filter::All))?;
    Ok(Response::new(
        200,
        json!({
            "availability": {
                "aiConfigured": true,
                "webSearchConfigured": false,
                "webSearchReason": "no-key-no-native-model",
                "customSourceByUrlEnabled": true,
                "customSourceByNameEnabled": false,
                "freeformTopicsEnabled": false,
            },
            "customSources": sources,
            "customTopics": topics,
            "sourceExclusions": exclusions,
            "snapshot": snapshot_meta(snapshot.first())?,
            "refresh": refresh_dto(refresh.first())?,
        }),
    ))
}

fn exclusion_by_domain<H: Host + ?Sized>(host: &H, canonical: &str) -> Result<Option<Value>> {
    let mut query = Query::select(Filter::eq("canonical_domain", canonical));
    query.limit = Some(1);
    Ok(Client(host).query(EXCLUSIONS, &query)?.into_iter().next())
}

/// `POST /source-exclusions`. A repeat returns the row already there.
pub fn add_exclusion<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let source = match input::new_exclusion(&request.body) {
        Ok(source) => source,
        Err(message) => return Ok(bad_request(message)),
    };
    let canonical = match domain::normalize(&source) {
        Ok(canonical) => canonical,
        Err(reason) => return Ok(bad_request(format!("Invalid publisher domain ({reason})"))),
    };
    let row = match exclusion_by_domain(host, &canonical)? {
        Some(row) => row,
        None => {
            if list(host, EXCLUSIONS)?.len() >= EXCLUSION_LIMIT {
                return Ok(bad_request(format!(
                    "news personalization limit reached: at most {EXCLUSION_LIMIT} source_exclusions per user"
                )));
            }
            let mut insert = Query::insert(values(vec![("canonical_domain", json!(canonical))]));
            insert.conflict = Conflict::Ignore;
            Client(host).query(EXCLUSIONS, &insert)?;
            exclusion_by_domain(host, &canonical)?.ok_or_else(|| Error::new("Exclusion could not be saved"))?
        }
    };
    Ok(Response::new(200, json!({"exclusion":exclusion_dto(&row)?})))
}

/// `DELETE /source-exclusions/:id`.
pub fn remove_exclusion<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let removed = Client(host).query(EXCLUSIONS, &Query::delete(Filter::eq("id", id)))?;
    Ok(Response::new(200, json!({"ok":!removed.is_empty()})))
}

fn discovery_unavailable() -> Response {
    error(503, "Topic discovery requires web search")
}

/// `POST /topics`. Checking a topic needs web search, which this package does not have.
pub fn add_topic<H: Host + ?Sized>(_host: &H, request: &RouteRequest) -> Result<Response> {
    let (label, _) = match input::new_topic(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    if js_trim(&label).is_empty() {
        return Ok(bad_request("Topic label is required"));
    }
    Ok(discovery_unavailable())
}

/// `PATCH /topics/:id`.
pub fn change_topic<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let (label, _) = match input::topic_change(&request.body) {
        Ok(parsed) => parsed,
        Err(message) => return Ok(bad_request(message)),
    };
    let mut find = Query::select(Filter::eq("id", id));
    find.limit = Some(1);
    if Client(host).query(TOPICS, &find)?.is_empty() {
        return Ok(bad_request("Topic was not found"));
    }
    if label.as_deref().is_some_and(|l| js_trim(l).is_empty()) {
        return Ok(bad_request("Topic label is required"));
    }
    Ok(discovery_unavailable())
}

/// `DELETE /topics/:id`.
pub fn remove_topic<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let removed = Client(host).query(TOPICS, &Query::delete(Filter::eq("id", id)))?;
    Ok(Response::new(200, json!({"deleted":!removed.is_empty()})))
}

/// `DELETE /sources/:id`. The saved feed is left as it is.
pub fn remove_source<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let id = match id_param(request) {
        Ok(id) => id,
        Err(refusal) => return Ok(refusal),
    };
    let client = Client(host);
    let removed = client.query(SOURCES, &Query::delete(Filter::eq("id", id)))?;
    Ok(Response::new(200, json!({"deleted":!removed.is_empty()})))
}
