#![allow(dead_code)]
//! An in-memory host that mimics the database rules the guest relies on. It stands in for the
//! typed-query layer, and the real-database tests in the host crate prove the same behaviour
//! against Postgres.
use moss_module_sdk::{
    query::{Compare, Conflict, Filter, Kind, Query},
    Host, Result, RouteRequest,
};
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

pub const A: &str = "00000000-0000-4000-8000-00000000000a";
pub const B: &str = "00000000-0000-4000-8000-00000000000b";

/// The sixteen collections the host reads for the account export.
pub const HOST_COLLECTIONS: &[&str] = &[
    "recording_types", "recording_metadata", "manual_entries", "voice_enablements", "recording_imports",
    "transcript_batches", "output_requests", "output_artifacts", "action_candidates", "export_receipts",
    "export_requests", "stop_summaries", "capture_grants", "capture_connections",
    "capture_start_cancellations", "capture_start_limits",
];

/// What the host's capture authority answers. A `None` means the caller is refused.
#[derive(Clone, Default)]
pub struct CaptureCfg {
    pub browser: Option<(String, String)>,
    pub native: Option<(String, i64, String)>,
    pub recording: Option<String>,
    pub route: Option<String>,
    /// The Mac's bearer credential for this request.
    pub credential: Option<String>,
}

pub struct Fake {
    pub capture: RefCell<CaptureCfg>,
    /// Every job the module queued, as (queue, parameters).
    pub jobs: RefCell<Vec<(String, Value)>>,
    pub actor: Cell<&'static str>,
    pub tables: RefCell<BTreeMap<String, Vec<Value>>>,
    pub prefs: RefCell<BTreeMap<String, Map<String, Value>>>,
    pub calls: RefCell<Vec<String>>,
    /// Stored transcript batches as (owner, meeting, batch) and the segment rows saved with them.
    pub batches: RefCell<Vec<(String, String, Value)>>,
    pub segments: RefCell<Vec<Value>>,
    /// What the History read returns, and the parameters of the last read.
    pub history_rows: RefCell<Vec<Value>>,
    pub history_asked: RefCell<Option<Value>>,
    pub history_fails: Cell<bool>,
    /// Private note copies the Notes stand-in holds, keyed by `<meeting>/v<version>`, and its switches.
    pub copies: RefCell<BTreeMap<String, String>>,
    pub notes_down: Cell<bool>,
    pub lose_write_answer: Cell<bool>,
    /// What the transcribe port answers to `create`, and every audio clip it was given.
    pub speech: RefCell<Value>,
    pub heard: RefCell<Vec<Value>>,
    /// What the host's account export read returns, per signed-in account.
    pub section: RefCell<BTreeMap<String, Value>>,
    clock: Cell<u32>,
    ids: Cell<u32>,
}

impl Fake {
    pub fn new() -> Self {
        Self {
            capture: RefCell::new(CaptureCfg::default()),
            speech: RefCell::new(json!({"ok": true, "route": "route-1", "segments": [{"startMs": 0, "endMs": 1000, "text": "hello there"}]})),
            heard: RefCell::new(vec![]),
            jobs: RefCell::new(vec![]),
            actor: Cell::new(A),
            tables: RefCell::new(BTreeMap::new()),
            prefs: RefCell::new(BTreeMap::new()),
            calls: RefCell::new(vec![]),
            batches: RefCell::new(vec![]),
            segments: RefCell::new(vec![]),
            history_rows: RefCell::new(vec![]),
            history_asked: RefCell::new(None),
            history_fails: Cell::new(false),
            copies: RefCell::new(BTreeMap::new()),
            notes_down: Cell::new(false),
            lose_write_answer: Cell::new(false),
            section: RefCell::new(BTreeMap::new()),
            clock: Cell::new(0),
            ids: Cell::new(0),
        }
    }
    pub fn as_actor(&self, actor: &'static str) {
        self.actor.set(actor);
    }
    pub fn route(&self, method: &str, path: &str, params: &[(&str, &str)], body: Value) -> (u16, Value) {
        self.route_query(method, path, params, &[], body)
    }
    pub fn route_query(
        &self,
        method: &str,
        path: &str,
        params: &[(&str, &str)],
        query: &[(&str, Value)],
        body: Value,
    ) -> (u16, Value) {
        let request = RouteRequest {
            method: method.into(),
            path: path.into(),
            params: params.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
            query: query.iter().map(|(k, v)| ((*k).into(), v.clone())).collect(),
            body,
        };
        let response = moss_meetings_module::route(self, request);
        (response.status, response.body)
    }
    pub fn rows(&self, table: &str) -> Vec<Value> {
        self.tables.borrow().get(table).cloned().unwrap_or_default()
    }
    fn stamp(&self) -> String {
        let n = self.clock.get();
        self.clock.set(n + 1);
        format!("2026-11-11T10:00:{:02}.{:03}+00:00", n / 1000 % 60, n % 1000)
    }
    pub fn tick_to(&self, millis: u32) {
        self.clock.set(millis);
    }
}

fn cmp(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (a, b) {
        (Value::String(x), Value::String(y)) => x.cmp(y),
        (Value::Number(x), Value::Number(y)) => x.as_f64().partial_cmp(&y.as_f64()).unwrap(),
        _ => panic!("fake host cannot compare {a} with {b}"),
    }
}
fn matches(row: &Value, filter: &Filter, actor: &str) -> bool {
    match filter {
        Filter::All => true,
        Filter::Owned => row["owner_user_id"] == actor,
        Filter::And { filters } => filters.iter().all(|f| matches(row, f, actor)),
        Filter::Or { filters } => filters.iter().any(|f| matches(row, f, actor)),
        Filter::Null { column, not } => row[column.as_str()].is_null() != *not,
        Filter::In { column, values } => values.contains(&row[column.as_str()]),
        Filter::Compare { column, op, value } => {
            let left = &row[column.as_str()];
            // Timestamps are compared as instants, not as text.
            let (l, r) = if column.ends_with("_at") && value.is_string() {
                (
                    Value::String(norm(left.as_str().unwrap_or(""))),
                    Value::String(norm(value.as_str().unwrap())),
                )
            } else {
                (left.clone(), value.clone())
            };
            let o = if l.is_null() { return false } else { cmp(&l, &r) };
            match op {
                Compare::Eq => o.is_eq(),
                Compare::Ne => o.is_ne(),
                Compare::Lt => o.is_lt(),
                Compare::Le => o.is_le(),
                Compare::Gt => o.is_gt(),
                Compare::Ge => o.is_ge(),
                _ => panic!("fake host does not model pattern filters"),
            }
        }
    }
}
fn norm(text: &str) -> String {
    chrono_free(text)
}
/// Both `...Z` and `...+00:00` spellings compare equal.
fn chrono_free(text: &str) -> String {
    text.replace("+00:00", "Z")
}

impl Fake {
    fn capture_call(&self, operation: &str, p: &Value) -> Value {
        let cfg = self.capture.borrow().clone();
        match operation {
            "lock" if p["kind"] == "meeting" => {
                let id = p["key"].clone();
                let found = self.rows("app.meeting_records").iter().any(|r| r["id"] == id && r["owner_user_id"] == self.actor.get());
                json!({"found": found})
            }
            "lock" => json!({}),
            "browser" => cfg.browser.map_or(json!({"found": false}), |(id, ends)| json!({"found": true, "sessionId": id, "expiresAt": ends})),
            "native" => cfg.native.map_or(json!({"found": false}), |(device, rev, ends)| {
                json!({"found": true, "deviceId": device, "deviceName": "Mac", "capabilityRevision": rev, "expiresAt": ends})
            }),
            "recording" => cfg.recording.map_or(json!({"found": false}), |ends| json!({"found": true, "expiresAt": ends})),
            "credential" => cfg.credential.map_or(json!({"found": false}), |c| json!({"found": true, "credential": c})),
            "processing" => json!({"ready": cfg.route.is_some(), "modelRoute": cfg.route}),
            other => panic!("unexpected capture operation {other}"),
        }
    }
}

impl Fake {
    /// The transcript store as the host adapter serves it: visible only to the owner.
    fn transcripts(&self, operation: &str, p: &Value) -> Value {
        let actor = self.actor.get();
        let meeting = p["meetingId"].as_str().unwrap_or_default().to_owned();
        match operation {
            "get" | "lock" => {
                let owned = self.rows("app.meeting_records").iter().any(|r| r["id"] == json!(meeting) && r["owner_user_id"] == actor);
                if !owned {
                    return json!({"found": false});
                }
                let batches: Vec<Value> = self.batches.borrow().iter().filter(|b| b.1 == meeting).map(|b| b.2.clone()).collect();
                let bytes: usize = batches.iter().map(|b| b["inputJson"].as_str().unwrap_or("").len()).sum();
                json!({"found": true, "ownerUserId": actor, "bytes": bytes, "batches": batches})
            }
            "set" => {
                self.batches.borrow_mut().push((
                    actor.into(),
                    meeting,
                    json!({"requestKey": p["requestKey"], "version": p["version"], "inputJson": p["inputJson"],
                        "transcriptRevision": p["transcriptRevision"], "cursor": p["cursor"], "stopCutoffMs": p["stopCutoffMs"]}),
                ));
                self.segments.borrow_mut().extend(p["segments"].as_array().cloned().unwrap_or_default());
                json!({})
            }
            other => panic!("unexpected transcript operation {other}"),
        }
    }
}

impl Fake {
    /// A stand-in for the Notes private copy API. It compares bytes and never overwrites.
    fn notes(&self, p: &Value) -> Result<Value> {
        if self.notes_down.get() {
            return Err(moss_module_sdk::Error::new("Notes service is unavailable"));
        }
        let args = &p["parameters"];
        let key = format!("{}/v{}", args["sourceId"].as_str().unwrap(), args["version"]);
        let content = args["content"].as_str().unwrap().to_owned();
        let reference = format!("notes/generated/{key}.md");
        let seen = self.copies.borrow().get(&key).cloned();
        let hash = format!("hash-of-{}", content.len());
        let answer = |status: &str| json!({"destination":"private-vault","audience":"owner","noteReference":reference,"contentHash":hash,"status":status});
        match p["name"].as_str().unwrap() {
            "inspectPrivateNote" => Ok(answer(match seen {
                None => "missing",
                Some(text) if text == content => "unchanged",
                Some(_) => "conflict",
            })),
            "exportPrivateNote" => {
                let status = match seen {
                    None => {
                        self.copies.borrow_mut().insert(key, content);
                        if self.lose_write_answer.replace(false) {
                            return Err(moss_module_sdk::Error::new("answer lost"));
                        }
                        "written"
                    }
                    Some(text) if text == content => "unchanged",
                    Some(_) => "conflict",
                };
                Ok(answer(status))
            }
            other => panic!("unexpected Notes call {other}"),
        }
    }
}

impl Host for Fake {
    fn call(&self, port: &str, operation: &str, resource: &str, parameters: Value) -> Result<Value> {
        self.calls.borrow_mut().push(format!("{port}.{operation}.{resource}"));
        match (port, operation) {
            ("context", "read") => Ok(json!({"now":self.stamp().replace("+00:00", "Z"), "actorUserId": self.actor.get()})),
            ("kv", _) if resource == "meetings.capture" => Ok(self.capture_call(operation, &parameters)),
            ("transcribe", "availability") => {
                let route = self.capture.borrow().route.clone();
                Ok(json!({"available": route.is_some(), "route": route}))
            }
            ("transcribe", "create") => {
                self.heard.borrow_mut().push(parameters);
                Ok(self.speech.borrow().clone())
            }
            ("jobs", _) if resource == "meetings.capture-maintenance" => {
                self.jobs.borrow_mut().push((resource.into(), parameters));
                Ok(json!({}))
            }
            ("context", "uuid") => {
                let n = self.ids.get();
                self.ids.set(n + 1);
                Ok(json!({"id": format!("00000000-0000-4000-8000-{n:012x}")}))
            }
            ("api", "call") if resource == "notes" => self.notes(&parameters),
            ("kv", "section") if resource == "meetings.exports" => {
                let mut all = Map::new();
                for name in HOST_COLLECTIONS {
                    all.insert((*name).into(), json!([]));
                }
                if let Some(Value::Object(mine)) = self.section.borrow().get(self.actor.get()) {
                    all.extend(mine.clone());
                }
                Ok(Value::Object(all))
            }
            ("kv", _) if resource == "meetings.outputs" => Ok(json!({})),
            ("jobs", _) => Ok(json!({})),
            ("kv", _) if resource == "meetings.recording-types" => Ok(json!({"locked": true})),
            ("kv", _) if resource == "meetings.transcripts" => Ok(self.transcripts(operation, &parameters)),
            ("kv", "get") if resource == "meetings.history" => {
                *self.history_asked.borrow_mut() = Some(parameters);
                if self.history_fails.get() {
                    return Err(moss_module_sdk::Error::new("History read failed"));
                }
                Ok(json!({"rows": self.history_rows.borrow().clone()}))
            }
            ("kv", "lock") => Ok(json!({})),
            ("kv", "get") => {
                let all = self.prefs.borrow();
                Ok(Value::Object(all.get(self.actor.get()).cloned().unwrap_or_default()))
            }
            ("kv", "set") => {
                let mut all = self.prefs.borrow_mut();
                let mine = all.entry(self.actor.get().into()).or_default();
                for (key, value) in parameters["writes"].as_object().unwrap() {
                    mine.insert(key.clone(), value.clone());
                }
                Ok(Value::Object(mine.clone()))
            }
            ("db", "query") => {
                let query: Query = serde_json::from_value(parameters)?;
                Ok(Value::Array(self.query(resource, query)))
            }
            _ => panic!("unexpected host call {port}.{operation}"),
        }
    }
}

impl Fake {
    fn query(&self, table: &str, query: Query) -> Vec<Value> {
        let actor = self.actor.get();
        let mut tables = self.tables.borrow_mut();
        match query.kind {
            Kind::Select => {
                let mut rows: Vec<Value> = tables
                    .get(table)
                    .into_iter()
                    .flatten()
                    .filter(|r| r["owner_user_id"] == actor && matches(r, &query.filter, actor))
                    .cloned()
                    .collect();
                // The installed host refuses a page over 1000 rows.
                assert!(query.limit.is_none_or(|n| (1..=1000).contains(&n)), "query limit over 1000");
                for order in query.order.iter().rev() {
                    rows.sort_by(|a, b| {
                        let o = cmp(&norm_value(&a[order.column.as_str()]), &norm_value(&b[order.column.as_str()]));
                        if order.descending { o.reverse() } else { o }
                    });
                }
                rows.into_iter().skip(query.offset as usize).take(query.limit.unwrap_or(1000) as usize).collect()
            }
            Kind::Insert => {
                let mut row = Map::new();
                row.insert("owner_user_id".into(), json!(actor));
                let now = self.stamp();
                match table {
                    "app.meeting_records" => {
                        let n = self.ids.get();
                        self.ids.set(n + 1);
                        row.insert("id".into(), json!(format!("00000000-0000-4000-8000-{n:012x}")));
                        row.insert("personal_notes".into(), json!(""));
                        row.insert("notes_revision".into(), json!(0));
                        row.insert("created_at".into(), json!(now));
                        row.insert("updated_at".into(), json!(now));
                        row.insert("creation_title".into(), query.values["title"].clone());
                    }
                    "app.meeting_capture_receipts" => {
                        row.insert("created_at".into(), json!(now));
                    }
                    "app.meeting_capture_grants" => {
                        let n = self.ids.get();
                        self.ids.set(n + 1);
                        row.insert("id".into(), json!(format!("00000000-0000-4000-8000-{n:012x}")));
                        row.insert("credential_hash".into(), Value::Null);
                        row.insert("created_at".into(), json!(now));
                        row.insert("updated_at".into(), json!(now));
                    }
                    "app.meeting_recording_metadata" => {
                        for (k, v) in [("revision", json!(0)), ("type_id", Value::Null), ("type_source", json!("automatic")),
                            ("side", Value::Null), ("confidence", Value::Null), ("reason", Value::Null),
                            ("recorded_at", Value::Null), ("source", json!("recording")), ("output_version", Value::Null)] {
                            row.insert(k.into(), v);
                        }
                    }
                    _ => {}
                }
                for (k, v) in &query.values {
                    row.insert(k.clone(), v.clone());
                }
                let key_columns: &[&str] = match table {
                    "app.meeting_records" => &["request_key"],
                    "app.meeting_note_writes" => &["meeting_id", "request_key"],
                    "app.meeting_recording_metadata" | "app.meeting_manual_entries" => &["meeting_id"],
                    "app.meeting_capture_receipts" => &["grant_id", "request_key"],
                    _ => &[],
                };
                let clash = tables.get(table).into_iter().flatten().any(|r| {
                    r["owner_user_id"] == actor && key_columns.iter().all(|c| r[*c] == row[*c])
                });
                if clash {
                    if let Conflict::Update { values, .. } = &query.conflict {
                        let mut out = vec![];
                        for r in tables.entry(table.into()).or_default().iter_mut() {
                            if r["owner_user_id"] == actor {
                                for (k, v) in values {
                                    r[k.as_str()] = v.clone();
                                }
                                out.push(r.clone());
                            }
                        }
                        return out;
                    }
                    assert_eq!(query.conflict, Conflict::Ignore, "unique violation on {table}");
                    return vec![];
                }
                let row = Value::Object(row);
                tables.entry(table.into()).or_default().push(row.clone());
                vec![row]
            }
            Kind::Update => {
                let mut out = vec![];
                for row in tables.entry(table.into()).or_default().iter_mut() {
                    if row["owner_user_id"] == actor && matches(row, &query.filter, actor) {
                        for (k, v) in &query.values {
                            row[k.as_str()] = v.clone();
                        }
                        out.push(row.clone());
                    }
                }
                out
            }
            Kind::Delete => {
                let rows = tables.entry(table.into()).or_default();
                let (gone, keep): (Vec<_>, Vec<_>) = rows
                    .drain(..)
                    .partition(|r| r["owner_user_id"] == actor && matches(r, &query.filter, actor));
                *rows = keep;
                // Foreign keys cascade to rows that name the deleted meeting.
                if table == "app.meeting_records" {
                    let ids: Vec<Value> = gone.iter().map(|r| r["id"].clone()).collect();
                    for (name, rows) in tables.iter_mut() {
                        if name != table {
                            rows.retain(|r| !ids.contains(&r["meeting_id"]));
                        }
                    }
                }
                gone
            }
        }
    }
}
fn norm_value(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(chrono_free(s)),
        other => other.clone(),
    }
}
