//! Selective export. A request saves a pending record and queues a job that carries only the
//! export id. The job reads the saved window and categories, builds the page from the owner's own
//! rows, and keeps the file for 24 hours. Export records and files live in this package's
//! per-account store. Nothing from a note or check-in goes into the job, a log or an error.
use crate::{
    input,
    notes::{self, NOTES},
    render::{self, Page},
    util::{bad_request, error},
};
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Map, Value};

pub const QUEUE: &str = "wellness-export";
pub const JOBS: &str = "wellness.export-jobs";
pub const FILES: &str = "wellness.export-files";
const KEEP: i64 = 24;
const STALE_MINUTES: i64 = 15;
const PRUNE_DAYS: i64 = 7;
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RANGE_DAYS: f64 = 366.0;
const FAILED: &str = "The export could not be built. Start it again.";
const TOO_LARGE: &str = "This export is too large. Choose a shorter date range or fewer categories.";
const STALLED: &str = "The export did not finish. Start it again.";

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn read_clock<H: Host + ?Sized>(host: &H) -> Result<(DateTime<Utc>, String)> {
    let call = host.call("context", "read", "call", json!({}))?;
    let now = call["now"]
        .as_str()
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
        .ok_or_else(|| Error::new("Host clock unavailable"))?;
    Ok((now, call["actorUserId"].as_str().unwrap_or_default().to_owned()))
}

fn load<H: Host + ?Sized>(host: &H, namespace: &str) -> Result<Map<String, Value>> {
    Ok(host.call("kv", "get", namespace, json!({}))?.as_object().cloned().unwrap_or_default())
}

fn save<H: Host + ?Sized>(host: &H, namespace: &str, map: &Map<String, Value>) -> Result<()> {
    host.call("kv", "set", namespace, Value::Object(map.clone())).map(|_| ())
}

fn instant(record: &Value, key: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(record[key].as_str()?).ok().map(|t| t.with_timezone(&Utc))
}

/// Moves records that ran out of time to their final state, then drops old ones. Returns whether
/// anything changed and which files are no longer needed.
fn settle(jobs: &mut Map<String, Value>, now: DateTime<Utc>) -> (bool, Vec<String>) {
    let mut changed = false;
    let mut files = Vec::new();
    let mut drop = Vec::new();
    for (id, record) in jobs.iter_mut() {
        let status = record["status"].as_str().unwrap_or("").to_owned();
        if status == "ready" && instant(record, "expiresAt").is_some_and(|at| at <= now) {
            record["status"] = json!("expired");
            files.push(id.clone());
            changed = true;
        } else if matches!(status.as_str(), "pending" | "building")
            && instant(record, "createdAt").is_some_and(|at| at + Duration::minutes(STALE_MINUTES) <= now)
        {
            record["status"] = json!("failed");
            record["errorMessage"] = json!(STALLED);
            changed = true;
        }
        let ended = instant(record, "expiresAt").or_else(|| instant(record, "createdAt"));
        if matches!(record["status"].as_str(), Some("expired" | "failed"))
            && ended.is_some_and(|at| at + Duration::days(PRUNE_DAYS) <= now)
        {
            drop.push(id.clone());
        }
    }
    for id in drop {
        jobs.remove(&id);
        files.push(id);
        changed = true;
    }
    (changed, files)
}

/// Loads the records with expiry applied. Expired files are removed.
fn current<H: Host + ?Sized>(host: &H, now: DateTime<Utc>) -> Result<Map<String, Value>> {
    let mut jobs = load(host, JOBS)?;
    let (changed, stale) = settle(&mut jobs, now);
    if changed {
        save(host, JOBS, &jobs)?;
    }
    if !stale.is_empty() {
        let mut files = load(host, FILES)?;
        let before = files.len();
        stale.iter().for_each(|id| {
            files.remove(id);
        });
        if files.len() != before {
            save(host, FILES, &files)?;
        }
    }
    Ok(jobs)
}

struct Window {
    from: NaiveDate,
    to: NaiveDate,
}

fn window(from: &str, to: &str) -> std::result::Result<Window, String> {
    let day = |t: &str| NaiveDate::parse_from_str(t, "%Y-%m-%d").map_err(|_| "from and to must be valid dates".to_owned());
    let (from, to) = (day(from)?, day(to)?);
    if from > to {
        return Err("from must be on or before to".into());
    }
    let millis = (to.and_hms_milli_opt(23, 59, 59, 999).unwrap() - from.and_hms_opt(0, 0, 0).unwrap()).num_milliseconds();
    if millis as f64 / 86_400_000.0 > MAX_RANGE_DAYS {
        return Err(format!("Date range must be at most {MAX_RANGE_DAYS} days"));
    }
    Ok(Window { from, to })
}

fn same_request(record: &Value, from: &str, to: &str, categories: &[String]) -> bool {
    let mut saved: Vec<&str> = record["params"]["categories"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let mut asked: Vec<&str> = categories.iter().map(String::as_str).collect();
    saved.sort_unstable();
    asked.sort_unstable();
    record["params"]["from"] == from && record["params"]["to"] == to && saved == asked
}

/// `POST /wellness/export`.
pub fn create<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let asked = match input::export_request(&request.body) {
        Ok(asked) => asked,
        Err(message) => return Ok(bad_request(message)),
    };
    if let Err(message) = window(&asked.from, &asked.to) {
        return Ok(bad_request(message));
    }
    if let Some(category) = asked.categories.iter().find(|c| !matches!(c.as_str(), "checkins" | "therapyNotes")) {
        return Ok(bad_request(format!("The {category} export is not available yet")));
    }
    let (now, _) = read_clock(host)?;
    let mut jobs = current(host, now)?;
    let active = jobs.values().find(|r| matches!(r["status"].as_str(), Some("pending" | "building")));
    if let Some(record) = active {
        if same_request(record, &asked.from, &asked.to, &asked.categories) {
            return Ok(Response::new(202, json!({"jobId": record["id"], "status": record["status"]})));
        }
        return Ok(error(
            409,
            "An export is already in progress with different parameters. Wait for it to finish before starting a new one.",
        ));
    }
    let id = host.call("context", "uuid", "new", json!({}))?["id"]
        .as_str()
        .ok_or_else(|| Error::new("No export id"))?
        .to_owned();
    jobs.insert(
        id.clone(),
        json!({"id": id, "status": "pending", "createdAt": stamp(now),
            "params": {"from": asked.from, "to": asked.to, "categories": asked.categories}}),
    );
    save(host, JOBS, &jobs)?;
    let queued = host.call(
        "jobs",
        "enqueue-options",
        QUEUE,
        json!({"params": {"export-id": id}, "idempotencyKey": id, "availableAt": stamp(now)}),
    );
    if queued.is_err() {
        jobs.remove(&id);
        save(host, JOBS, &jobs)?;
        return Err(Error::new("Export could not be queued"));
    }
    Ok(Response::new(202, json!({"jobId": id, "status": "pending"})))
}

fn record_for<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<std::result::Result<Value, Response>> {
    let (now, _) = read_clock(host)?;
    let id = request.params.get("id").map(String::as_str).unwrap_or_default();
    Ok(current(host, now)?.get(id).cloned().ok_or_else(|| error(404, "Export job not found")))
}

/// `GET /wellness/export/:id`.
pub fn status<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let record = match record_for(host, request)? {
        Ok(record) => record,
        Err(response) => return Ok(response),
    };
    let mut body = json!({"jobId": record["id"], "status": record["status"]});
    if let Some(at) = record.get("expiresAt").filter(|v| !v.is_null()) {
        body["expiresAt"] = at.clone();
    }
    if let Some(message) = record.get("errorMessage").filter(|v| !v.is_null()) {
        body["errorMessage"] = message.clone();
    }
    Ok(Response::new(200, body))
}

/// `GET /wellness/export/:id/download`. A package route sends JSON only, so the page comes back
/// inside an envelope with its file name and type.
pub fn download<H: Host + ?Sized>(host: &H, request: &RouteRequest) -> Result<Response> {
    let record = match record_for(host, request)? {
        Ok(record) => record,
        Err(response) => return Ok(response),
    };
    match record["status"].as_str() {
        Some("ready") => {}
        Some("expired") => return Ok(error(410, "Export has expired")),
        _ => return Ok(error(404, "Export not ready")),
    }
    let id = record["id"].as_str().unwrap_or_default();
    let Some(page) = load(host, FILES)?.get(id).and_then(Value::as_str).map(str::to_owned) else {
        return Ok(error(410, "Export has expired"));
    };
    let name = format!(
        "wellness-export-{}-to-{}.html",
        record["params"]["from"].as_str().unwrap_or_default(),
        record["params"]["to"].as_str().unwrap_or_default()
    );
    Ok(Response::new(200, json!({"filename": name, "contentType": "text/html; charset=utf-8", "html": page})))
}

fn range_rows<H: Host + ?Sized>(host: &H, table: &str, column: &str, window: &Window) -> Result<Vec<Value>> {
    let edge = |op, value: String| Filter::Compare { column: column.into(), op, value: json!(value) };
    let mut query = Query::select(Filter::And {
        filters: vec![
            edge(Compare::Ge, format!("{}T00:00:00.000Z", window.from)),
            edge(Compare::Le, format!("{}T23:59:59.999Z", window.to)),
        ],
    });
    query.order = vec![
        Order { column: column.into(), descending: false },
        Order { column: "id".into(), descending: false },
    ];
    query.limit = Some(5000);
    Client(host).query(table, &query)
}

fn checkin_item(row: &Value) -> Result<Value> {
    let item = |key: &str| row[key].clone();
    Ok(json!({
        "checkedInAt": crate::util::iso_or_null(&row["checked_in_at"])?,
        "feelingCore": item("feeling_core"),
        "feelingSecondary": item("feeling_secondary"),
        "intensity": item("intensity"),
        "energy": item("energy"),
        "note": item("note"),
        "sensations": item("sensations"),
    }))
}

fn build<H: Host + ?Sized>(host: &H, record: &Value, now: DateTime<Utc>, owner: &str) -> Result<String> {
    let params = &record["params"];
    let from = params["from"].as_str().unwrap_or_default();
    let to = params["to"].as_str().unwrap_or_default();
    let range = window(from, to).map_err(|m| Error::new(m))?;
    let wants = |name: &str| params["categories"].as_array().into_iter().flatten().any(|c| c == name);
    let checkins = if wants("checkins") {
        Some(range_rows(host, crate::checkins::CHECKINS, "checked_in_at", &range)?.iter().map(checkin_item).collect::<Result<Vec<_>>>()?)
    } else {
        None
    };
    let therapy = if wants("therapyNotes") {
        Some(range_rows(host, NOTES, "created_at", &range)?.iter().map(notes::dto).collect::<Result<Vec<_>>>()?)
    } else {
        None
    };
    let html = render::html(&Page {
        owner,
        from,
        to,
        generated_at: &stamp(now),
        checkins: checkins.as_deref(),
        therapy_notes: therapy.as_deref(),
    });
    if html.len() > MAX_PAGE_BYTES {
        return Err(Error::new("too large"));
    }
    Ok(html)
}

fn finish<H: Host + ?Sized>(host: &H, id: &str, change: impl FnOnce(&mut Value)) -> Result<()> {
    let mut jobs = load(host, JOBS)?;
    if let Some(record) = jobs.get_mut(id) {
        change(record);
    }
    save(host, JOBS, &jobs)
}

/// The queue worker. The payload names the export and nothing else.
pub fn run<H: Host + ?Sized>(host: &H, payload: &str) -> moss_module_sdk::Result<String> {
    let payload: Value = serde_json::from_str(payload)?;
    let id = payload["parameters"]["export-id"].as_str().ok_or_else(|| Error::new("Export id missing"))?.to_owned();
    let (now, owner) = read_clock(host)?;
    let jobs = load(host, JOBS)?;
    let Some(record) = jobs.get(&id).filter(|r| r["status"] == "pending").cloned() else {
        return Ok("{}".into());
    };
    finish(host, &id, |r| r["status"] = json!("building"))?;
    let built = build(host, &record, now, &owner);
    let outcome = built.and_then(|page| {
        let mut files = load(host, FILES)?;
        files.insert(id.clone(), json!(page));
        save(host, FILES, &files).map_err(|_| Error::new("too large"))
    });
    match outcome {
        Ok(()) => finish(host, &id, |r| {
            r["status"] = json!("ready");
            r["completedAt"] = json!(stamp(now));
            r["expiresAt"] = json!(stamp(now + Duration::hours(KEEP)));
        })?,
        Err(e) => {
            let message = if e.message == "too large" { TOO_LARGE } else { FAILED };
            finish(host, &id, |r| {
                r["status"] = json!("failed");
                r["errorMessage"] = json!(message);
            })?
        }
    }
    Ok("{}".into())
}
