//! Vault index jobs. A tick keeps one sweep per account moving, a sweep walks the ingestable
//! files a page at a time, and a nudge re-checks one exported note. Jobs carry only counts and an
//! opaque row id. Paths live in the owner-scoped nudge table and in host responses.
use moss_module_sdk::{
    query::{Compare, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub const TICK: &str = "memory.vault-ingest-tick";
pub const SWEEP: &str = "memory.vault-ingest-sweep";
pub const NUDGE: &str = "memory.vault-ingest-nudge";
const TABLE: &str = "app.memory_ingest_nudges";
const SOURCE: &str = "vault-index";
/// Files indexed per sweep job. A long folder continues in a follow-up job.
const PAGE: usize = 20;
/// Chunks embedded per host call. A larger file continues in further calls.
const CHUNKS: u64 = 64;
/// A repeat nudge for the same note inside this window adds nothing.
const DEDUP_SECONDS: i64 = 300;
const REFERENCE_ROOT: &str = "notes/generated/";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    queue: String,
    parameters: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NudgeRequest {
    source_path: String,
    op: String,
}

fn unavailable() -> Error {
    Error::new("Memory vault index is unavailable")
}

fn vault(host: &impl Host, operation: &str, parameters: Value) -> Result<Value> {
    let value = host.call("vault", operation, SOURCE, parameters)?;
    if value.get("error").is_some() {
        return Err(unavailable());
    }
    Ok(value)
}

/// Keeps one fifteen-minute schedule per account. The stable key makes repeat calls replace it.
pub fn reconcile_schedule(host: &impl Host) {
    let _ = host.call(
        "jobs",
        "schedule",
        TICK,
        json!({"cron":"*/15 * * * *","timezone":"UTC","key":"memory-vault-ingest","params":{}}),
    );
}

fn now(host: &impl Host) -> Result<String> {
    let context = host.call("context", "read", "call", json!({}))?;
    Ok(context["now"].as_str().ok_or_else(unavailable)?.to_owned())
}

pub(crate) fn new_id(host: &impl Host) -> Result<String> {
    let id = host.call("context", "uuid", "new", json!({}))?;
    Ok(id["id"].as_str().ok_or_else(unavailable)?.to_owned())
}

pub(crate) fn enqueue_now(host: &impl Host, queue: &str, params: Value, key: &str) -> Result<()> {
    host.call(
        "jobs",
        "enqueue-options",
        queue,
        json!({"params":params,"idempotencyKey":key,"availableAt":now(host)?}),
    )?;
    Ok(())
}

pub fn handle_job(host: &impl Host, payload: &str) -> Result<String> {
    let job: Job = serde_json::from_str(payload)?;
    match job.queue.as_str() {
        TICK => {
            reconcile_schedule(host);
            enqueue_now(host, SWEEP, json!({"offset":0}), &new_id(host)?)?;
            crate::reembed::retry_missing(host);
            Ok(json!({"started":true}).to_string())
        }
        SWEEP => sweep(host, job.parameters["offset"].as_u64().ok_or_else(unavailable)? as usize),
        NUDGE => nudge(
            host,
            job.parameters["nudge-id"].as_str().ok_or_else(unavailable)?,
        ),
        _ => Err(unavailable()),
    }
}

/// Indexes one file through every continuation page. Returns true when it was indexed or skipped.
fn index_file(host: &impl Host, path: &str) -> bool {
    loop {
        let Ok(result) = vault(host, "index.vault-file", json!({"path":path,"chunkLimit":CHUNKS}))
        else {
            return false;
        };
        if result["continuation"] != true {
            return true;
        }
    }
}

fn sweep(host: &impl Host, offset: usize) -> Result<String> {
    let listed = vault(host, "index.vault-list", json!({}))?;
    let files: Vec<&str> = listed["files"]
        .as_array()
        .ok_or_else(unavailable)?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let end = (offset + PAGE).min(files.len());
    let (mut done, mut failed) = (0u64, 0u64);
    for path in files.get(offset..end).unwrap_or_default() {
        if index_file(host, path) {
            done += 1;
        } else {
            failed += 1;
        }
    }
    if end < files.len() {
        enqueue_now(host, SWEEP, json!({"offset":end}), &new_id(host)?)?;
    } else {
        // Only the last page knows which rows no longer match a file on disk.
        vault(host, "index.vault-purge", json!({}))?;
    }
    Ok(json!({"indexed":done,"failed":failed,"more":end < files.len()}).to_string())
}

/// True for `notes/generated/<id>/v<n>.md`, the only shape a private note export has.
fn is_export_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix(REFERENCE_ROOT) else { return false };
    let Some((id, file)) = rest.split_once('/') else { return false };
    let version = file.strip_prefix('v').and_then(|f| f.strip_suffix(".md"));
    uuid_like(id) && version.is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

fn uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// Records a request to index (or drop) one exported note and queues a job that carries only
/// the row id. A repeat inside five minutes is absorbed.
pub fn request(host: &impl Host, input: NudgeRequest) -> Result<Value> {
    if !is_export_path(&input.source_path) || !matches!(input.op.as_str(), "upsert" | "delete") {
        return Err(Error::new("Invalid vault index request"));
    }
    reconcile_schedule(host);
    let now = now(host)?;
    let cutoff = shift_seconds(&now, -DEDUP_SECONDS).ok_or_else(unavailable)?;
    let mut query = Query::select(Filter::And {
        filters: vec![
            Filter::eq("source_path", json!(input.source_path)),
            Filter::eq("op", json!(input.op)),
            Filter::Compare {
                column: "created_at".into(),
                op: Compare::Ge,
                value: json!(cutoff),
            },
        ],
    });
    query.limit = Some(1);
    query.order = vec![Order {
        column: "created_at".into(),
        descending: true,
    }];
    if !Client(host).query(TABLE, &query)?.is_empty() {
        return Ok(json!({"queued":false}));
    }
    let id = new_id(host)?;
    Client(host).query(
        TABLE,
        &Query::insert(
            [
                ("id".into(), json!(id)),
                ("source_path".into(), json!(input.source_path)),
                ("op".into(), json!(input.op)),
            ]
            .into(),
        ),
    )?;
    let queued = host.call(
        "jobs",
        "enqueue-after-commit",
        NUDGE,
        json!({"params":{"nudge-id":id},"idempotencyKey":id,"availableAt":now}),
    )?;
    Ok(json!({"queued":queued["deferred"] == true}))
}

fn nudge(host: &impl Host, id: &str) -> Result<String> {
    if !uuid_like(id) {
        return Err(unavailable());
    }
    let rows = Client(host).query(TABLE, &Query::select(Filter::eq("id", json!(id))))?;
    // A row removed by an earlier delivery of this job means the work is done.
    let Some(row) = rows.first() else {
        return Ok(json!({"noOp":true}).to_string());
    };
    let path = row["source_path"].as_str().ok_or_else(unavailable)?;
    let op = row["op"].as_str().ok_or_else(unavailable)?;
    if !is_export_path(path) {
        return Err(unavailable());
    }
    let ok = match op {
        "upsert" => index_file(host, path),
        _ => vault(host, "index.vault-remove", json!({"path":path})).is_ok(),
    };
    if ok {
        Client(host).query(TABLE, &Query::delete(Filter::eq("id", json!(id))))?;
    }
    Ok(json!({"indexed":ok}).to_string())
}

/// Shifts an RFC 3339 UTC time (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) by whole seconds.
fn shift_seconds(time: &str, delta: i64) -> Option<String> {
    let (date, clock) = time.split_once('T')?;
    let mut d = date.split('-').map(|n| n.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut c = clock.get(..8)?.split(':').map(|n| n.parse::<i64>().ok());
    let secs = c.next()?? * 3600 + c.next()?? * 60 + c.next()??;
    let (yy, mm) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let total = (era * 146097 + doe - 719468) * 86400 + secs + delta;
    let (days, rem) = (total.div_euclid(86400), total.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const ID: &str = "11111111-2222-3333-4444-555555555555";
    const MARKER: &str = "PLANTED-MARKER-7f3a";

    /// Records every port call and answers from a small in-memory script.
    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<(String, String, String, Value)>>,
        files: Vec<String>,
        rows: RefCell<Vec<Value>>,
        next_id: RefCell<u32>,
    }
    impl Host for Fake {
        fn call(&self, port: &str, op: &str, resource: &str, params: Value) -> Result<Value> {
            self.calls
                .borrow_mut()
                .push((port.into(), op.into(), resource.into(), params.clone()));
            Ok(match (port, op) {
                ("context", "read") => json!({"now":"2026-11-11T10:00:00.000Z"}),
                ("context", "uuid") => {
                    *self.next_id.borrow_mut() += 1;
                    json!({"id":format!("00000000-0000-4000-8000-{:012}", self.next_id.borrow())})
                }
                ("vault", "index.vault-list") => json!({"files":self.files}),
                ("vault", "index.vault-file") => json!({"status":"ingested","chunksProcessed":1}),
                ("vault", _) => json!({"removed":true}),
                ("jobs", "enqueue-after-commit") => json!({"deferred":true}),
                ("jobs", _) => json!({"id":ID}),
                ("db", _) => match params["kind"].as_str() {
                    Some("insert") => {
                        self.rows.borrow_mut().push(params["values"].clone());
                        json!([])
                    }
                    Some("delete") => {
                        self.rows.borrow_mut().clear();
                        json!([])
                    }
                    _ => json!(self.rows.borrow().clone()),
                },
                _ => json!({}),
            })
        }
    }

    fn jobs(fake: &Fake) -> Vec<(String, Value)> {
        fake.calls
            .borrow()
            .iter()
            .filter(|c| c.0 == "jobs")
            .map(|c| (c.1.clone(), c.3.clone()))
            .collect()
    }

    fn payload(queue: &str, parameters: Value) -> String {
        json!({"queue":queue,"parameters":parameters}).to_string()
    }

    #[test]
    fn only_export_paths_are_accepted() {
        let id = "11111111-2222-3333-4444-555555555555";
        assert!(is_export_path(&format!("notes/generated/{id}/v3.md")));
        for bad in [
            "notes/generated/x/v1.md",
            &format!("notes/generated/{id}/v.md"),
            &format!("notes/generated/{id}/../v1.md"),
            &format!("attachments/{id}/v1.md"),
            &format!("notes/generated/{id}/v1.txt"),
        ] {
            assert!(!is_export_path(bad), "{bad}");
        }
    }

    #[test]
    fn time_shift_crosses_a_day() {
        assert_eq!(
            shift_seconds("2026-11-10T00:02:00.123Z", -300).unwrap(),
            "2026-11-09T23:57:00Z"
        );
    }

    #[test]
    fn a_tick_keeps_one_keyed_fifteen_minute_schedule_and_starts_a_sweep() {
        let fake = Fake::default();
        handle_job(&fake, &payload(TICK, json!({}))).unwrap();
        handle_job(&fake, &payload(TICK, json!({}))).unwrap();
        let calls = jobs(&fake);
        let schedules: Vec<_> = calls.iter().filter(|c| c.0 == "schedule").collect();
        assert_eq!(schedules.len(), 2);
        for (_, params) in schedules {
            assert_eq!(params["cron"], "*/15 * * * *");
            assert_eq!(params["timezone"], "UTC");
            assert_eq!(params["key"], "memory-vault-ingest");
            assert_eq!(params["params"], json!({}));
        }
        let sweeps = calls.iter().filter(|c| c.0 == "enqueue-options").count();
        assert_eq!(sweeps, 2);
    }

    #[test]
    fn a_sweep_pages_by_count_and_purges_only_on_the_last_page() {
        let mut fake = Fake::default();
        fake.files = (0..45).map(|i| format!("notes/n{i}.md")).collect();
        let out = handle_job(&fake, &payload(SWEEP, json!({"offset":0}))).unwrap();
        assert!(out.contains("\"more\":true"));
        assert!(!fake.calls.borrow().iter().any(|c| c.1 == "index.vault-purge"));
        let next = jobs(&fake).pop().unwrap().1;
        assert_eq!(next["params"], json!({"offset":20}));
        handle_job(&fake, &payload(SWEEP, json!({"offset":40}))).unwrap();
        assert_eq!(
            fake.calls.borrow().iter().filter(|c| c.1 == "index.vault-purge").count(),
            1
        );
    }

    #[test]
    fn no_job_call_carries_a_note_path() {
        let mut fake = Fake::default();
        fake.files = (0..25).map(|i| format!("notes/{MARKER}-{i}.md")).collect();
        handle_job(&fake, &payload(TICK, json!({}))).unwrap();
        handle_job(&fake, &payload(SWEEP, json!({"offset":0}))).unwrap();
        let path = format!("notes/generated/{ID}/v1.md");
        request(&fake, NudgeRequest { source_path: path, op: "upsert".into() }).unwrap();
        handle_job(&fake, &payload(NUDGE, json!({"nudge-id":ID}))).unwrap();
        let calls = jobs(&fake);
        assert!(calls.len() >= 5, "the flows must have queued work");
        for (op, params) in &calls {
            let text = params.to_string();
            assert!(!text.contains(MARKER), "{op} leaked a path: {text}");
            assert!(!text.contains("notes/generated"), "{op} leaked a path: {text}");
        }
    }

    #[test]
    fn a_repeat_nudge_is_absorbed_and_a_bad_path_is_refused() {
        let fake = Fake::default();
        let path = format!("notes/generated/{ID}/v2.md");
        let ask = || request(&fake, NudgeRequest { source_path: path.clone(), op: "upsert".into() });
        assert_eq!(ask().unwrap()["queued"], true);
        assert_eq!(ask().unwrap()["queued"], false);
        assert_eq!(
            jobs(&fake).iter().filter(|c| c.0 == "enqueue-after-commit").count(),
            1
        );
        let bad = NudgeRequest { source_path: "attachments/a/v1.md".into(), op: "upsert".into() };
        assert!(request(&fake, bad).is_err());
    }

    #[test]
    fn a_nudge_that_was_already_handled_does_nothing() {
        let fake = Fake::default();
        let out = handle_job(&fake, &payload(NUDGE, json!({"nudge-id":ID}))).unwrap();
        assert!(out.contains("noOp"));
        assert!(!fake.calls.borrow().iter().any(|c| c.0 == "vault"));
    }
}
