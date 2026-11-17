//! Refresh state and history, the two background queues and the daily schedule. Requests to
//! refresh are best effort. A write that changes what the page shows records a new generation,
//! queues one job if none is open, and keeps the daily check in step with the person's sources.
//! Job payloads carry only the queue name and one fixed word.
use crate::compile::{self, Built, FailureKind};
use crate::personalization::{REFRESH, SOURCES, TOPICS};
use crate::revalidate;
use crate::util::{new_id, now, values};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Error, Host, Response, Result,
};
use serde_json::{json, Value};

pub const REFRESH_QUEUE: &str = "news-refresh";
pub const REVALIDATE_QUEUE: &str = "news-revalidate";
const SCHEDULE_CRON: &str = "43 4 * * *";
const SCHEDULE_ZONE: &str = "UTC";
const SCHEDULE_KEY: &str = "daily-revalidation";
/// How often one refresh run starts over because newer changes arrived while it worked.
const MAX_RESTARTS: usize = 3;
/// How often a compare-and-set write retries when another write wins the race.
const MAX_RACES: usize = 5;
const KEYS: [&str; 2] = ["queue", "parameters"];

fn stamp<H: Host + ?Sized>(host: &H) -> Result<String> {
    Ok(now(host)?.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn read_state<H: Host + ?Sized>(host: &H) -> Result<Option<Value>> {
    Ok(Client(host).query(REFRESH, &Query::select(Filter::All))?.into_iter().next())
}

fn generation(row: &Value) -> i64 {
    row["requested_generation"].as_i64().unwrap_or(0)
}

/// Updates the state row only while the requested generation still equals `expected`.
fn update_if_current<H: Host + ?Sized>(host: &H, expected: i64, set: Vec<(&str, Value)>) -> Result<bool> {
    let mut set = values(set);
    set.insert("updated_at".into(), json!(stamp(host)?));
    let filter = Filter::eq("requested_generation", json!(expected));
    Ok(!Client(host).query(REFRESH, &Query::update(filter, set))?.is_empty())
}

/// Inserts the first state row at generation 1. False means another writer created it first.
fn create_state<H: Host + ?Sized>(host: &H, state: &str) -> Result<bool> {
    let at = stamp(host)?;
    let mut insert = Query::insert(values(vec![
        ("state", json!(state)),
        ("requested_generation", json!(1)),
        ("compiled_generation", json!(0)),
        ("last_requested_at", json!(at)),
        ("updated_at", json!(at)),
    ]));
    insert.conflict = Conflict::Ignore;
    Ok(!Client(host).query(REFRESH, &insert)?.is_empty())
}

/// Records that the page is out of date. With `ensure` an already queued or running refresh
/// is left alone. Returns the state the person sees and the generation now requested.
pub fn bump<H: Host + ?Sized>(host: &H, ensure: bool) -> Result<String> {
    for _ in 0..MAX_RACES {
        let at = stamp(host)?;
        let Some(row) = read_state(host)? else {
            if create_state(host, "queued")? {
                return Ok("queued".into());
            }
            continue;
        };
        let state = row["state"].as_str().unwrap_or("idle").to_owned();
        if ensure && matches!(state.as_str(), "queued" | "running") {
            return Ok(state);
        }
        let next = if state == "running" { "running" } else { "queued" };
        let set = vec![
            ("state", json!(next)),
            ("requested_generation", json!(generation(&row) + 1)),
            ("failure_kind", Value::Null),
            ("last_requested_at", json!(at)),
        ];
        if update_if_current(host, generation(&row), set)? {
            return Ok(next.into());
        }
    }
    Err(Error::new("Refresh state is busy"))
}

/// Marks a run as started and returns the generation it works for.
fn begin<H: Host + ?Sized>(host: &H) -> Result<i64> {
    for _ in 0..MAX_RACES {
        let Some(row) = read_state(host)? else {
            // The queue can deliver the first job before the request that queued it commits.
            create_state(host, "running")?;
            continue;
        };
        let set = vec![
            ("state", json!("running")),
            ("failure_kind", Value::Null),
            ("last_attempt_at", json!(stamp(host)?)),
        ];
        if update_if_current(host, generation(&row), set)? {
            return Ok(generation(&row));
        }
    }
    Err(Error::new("Refresh state is busy"))
}

/// Marks the run done. False means a newer request arrived and nothing was recorded.
fn finish_if_current<H: Host + ?Sized>(host: &H, run: i64) -> Result<bool> {
    let at = stamp(host)?;
    update_if_current(
        host,
        run,
        vec![
            ("state", json!("idle")),
            ("compiled_generation", json!(run)),
            ("failure_kind", Value::Null),
            ("last_success_at", json!(at)),
        ],
    )
}

fn fail_if_current<H: Host + ?Sized>(host: &H, run: i64, kind: FailureKind) -> Result<bool> {
    let at = stamp(host)?;
    update_if_current(
        host,
        run,
        vec![
            ("state", json!("failed")),
            ("failure_kind", json!(kind.word())),
            ("last_failure_at", json!(at)),
            ("last_failure_kind", json!(kind.word())),
        ],
    )
}

fn has_pending<H: Host + ?Sized>(host: &H, queue: &str) -> Result<bool> {
    // A running job may already have read the state, so only a pending job covers a new request.
    let open = host.call("jobs", "list-open", queue, json!({}))?;
    Ok(open["jobs"]
        .as_array()
        .is_some_and(|jobs| jobs.iter().any(|job| job["state"] == "pending")))
}

/// Queues one job unless one is already open. Returns whether a job was queued.
fn enqueue<H: Host + ?Sized>(host: &H, queue: &str, kind: &str) -> Result<bool> {
    if has_pending(host, queue)? {
        return Ok(false);
    }
    let sent = host.call(
        "jobs",
        "enqueue-options",
        queue,
        json!({"params":{"kind":kind},"idempotencyKey":new_id(host)?,"availableAt":stamp(host)?}),
    )?;
    Ok(sent["id"].is_string())
}

pub fn enqueue_refresh<H: Host + ?Sized>(host: &H) -> Result<bool> {
    enqueue(host, REFRESH_QUEUE, "user_refresh")
}

pub fn enqueue_revalidation<H: Host + ?Sized>(host: &H) -> Result<bool> {
    enqueue(host, REVALIDATE_QUEUE, "revalidate")
}

/// The daily check runs only for a person who has added a source or topic.
pub fn reconcile_schedule<H: Host + ?Sized>(host: &H) -> Result<()> {
    let client = Client(host);
    let mut one = Query::select(Filter::All);
    one.limit = Some(1);
    let registered = host.call(
        "jobs",
        "schedule",
        REVALIDATE_QUEUE,
        json!({
            "cron": SCHEDULE_CRON, "timezone": SCHEDULE_ZONE, "key": SCHEDULE_KEY,
            "params": {"kind": "revalidate"}, "keepExisting": true,
        }),
    )?;
    // Read after registering so a source removed in the meantime is not missed.
    let wanted = !client.query(SOURCES, &one)?.is_empty() || !client.query(TOPICS, &one)?.is_empty();
    if !wanted {
        if let Some(id) = registered["id"].as_str() {
            host.call("jobs", "unschedule", REVALIDATE_QUEUE, json!({"id": id}))?;
        }
    }
    Ok(())
}

/// Called after every write that changes the page. It never fails the write.
pub fn request<H: Host + ?Sized>(host: &H) {
    let _ = bump(host, false);
    let _ = reconcile_schedule(host);
    let _ = enqueue_refresh(host);
}

/// Called on reads. A page that is missing or out of date gets one refresh, and the schedule
/// heals itself. It never fails the read.
pub fn ensure<H: Host + ?Sized>(host: &H, page_is_stale: bool) {
    if page_is_stale {
        let _ = bump(host, true);
        let _ = enqueue_refresh(host);
    }
    let _ = reconcile_schedule(host);
}

/// `POST /refresh`.
pub fn route_refresh<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let state = bump(host, false)?;
    let _ = reconcile_schedule(host);
    let queued = enqueue_refresh(host)?;
    Ok(Response::new(200, json!({"queued": queued, "state": state})))
}

/// `POST /revalidation`.
pub fn route_revalidation<H: Host + ?Sized>(host: &H) -> Result<Response> {
    let queued = enqueue_revalidation(host)?;
    Ok(Response::new(202, json!({"queued": queued})))
}

/// The queue a delivery came on and the fixed word it carries.
fn delivery(payload: &str) -> Result<(String, String)> {
    let value: Value = serde_json::from_str(payload).map_err(|_| Error::new("Invalid job"))?;
    if !value.as_object().is_some_and(|map| map.keys().all(|key| KEYS.contains(&key.as_str()))) {
        return Err(Error::new("Job payload is not metadata only"));
    }
    let parameters = value["parameters"].as_object().ok_or_else(|| Error::new("Invalid job"))?;
    let kind = parameters.get("kind").and_then(Value::as_str).unwrap_or_default();
    if parameters.len() != 1 {
        return Err(Error::new("Invalid job"));
    }
    Ok((value["queue"].as_str().unwrap_or_default().to_owned(), kind.to_owned()))
}

/// Runs one delivery from either queue.
pub fn handle_job<H: Host + ?Sized>(host: &H, payload: &str) -> Result<String> {
    let (queue, kind) = delivery(payload)?;
    match (queue.as_str(), kind.as_str()) {
        (REFRESH_QUEUE, "user_refresh") => Ok(run_refresh(host)?.to_string()),
        (REVALIDATE_QUEUE, "revalidate") => Ok(revalidate::run(host)?.to_string()),
        _ => Err(Error::new("Invalid job")),
    }
}

/// Compiles the page for the latest request. A run starts over when a newer request arrives
/// while it works, and only a run for the current generation stores its page or its result.
fn run_refresh<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let mut stored = false;
    for _ in 0..MAX_RESTARTS {
        let run = begin(host)?;
        match compile::build(host)? {
            Built::Failed(kind) => {
                if fail_if_current(host, run, kind)? {
                    return Ok(json!({"ok": false, "failure": kind.word()}));
                }
            }
            built => {
                // The page is written before the state moves, and only for the current run.
                let current = read_state(host)?.is_some_and(|row| generation(&row) == run);
                if current {
                    if let Built::Page { at, payload } = &built {
                        compile::store(host, *at, payload)?;
                        stored = true;
                    }
                }
                if finish_if_current(host, run)? {
                    if stored && drifted(host)? {
                        enqueue_revalidation(host)?;
                    }
                    return Ok(json!({"ok": true, "stored": stored}));
                }
            }
        }
    }
    // Newer requests kept arriving. Their own queued job picks them up.
    Ok(json!({"ok": true, "stored": stored, "restarted": true}))
}

/// Any saved source or topic checked under another model fingerprint needs a new check.
fn drifted<H: Host + ?Sized>(host: &H) -> Result<bool> {
    let client = Client(host);
    let stale = |rows: &[Value]| {
        rows.iter().any(|row| {
            row["validation_status"] == "approved"
                && row["validation_fingerprint"].as_str() != Some(crate::policy::FINGERPRINT)
        })
    };
    let all = Query::select(Filter::All);
    Ok(stale(&client.query(SOURCES, &all)?) || stale(&client.query(TOPICS, &all)?))
}
