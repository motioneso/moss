//! Meeting records, titles and personal notes. Every call shares one host invocation, which owns
//! the transaction and runs as the signed-in person under row level security.
use crate::schema::{id_params, strict_object, Failure, Kind};
use crate::text::{bounded, is_iso_millis, js_trim};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{
    query::{Compare, Conflict, Filter, Order, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const RECORDS: &str = "app.meeting_records";
pub const NOTE_WRITES: &str = "app.meeting_note_writes";
pub const METADATA: &str = "app.meeting_recording_metadata";

fn bad_request(failure: Failure) -> Response {
    Response::new(400, json!({"error":failure}))
}
fn code(status: u16, code: &str) -> Response {
    Response::new(status, json!({"code":code}))
}
fn invalid() -> Response {
    code(400, "meeting_invalid_input")
}
fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// Database timestamps become the JavaScript `toISOString` form the old app returned.
pub(crate) fn iso(value: &Value) -> Result<String> {
    let text = value
        .as_str()
        .ok_or_else(|| moss_module_sdk::Error::new("Invalid meeting row"))?;
    let at = DateTime::parse_from_rfc3339(text)
        .map_err(|_| moss_module_sdk::Error::new("Invalid meeting row"))?;
    Ok(at.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// What a person sees of one meeting. Replays build this from stored snapshots.
pub struct Snapshot {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}
impl Snapshot {
    pub fn from_row(row: &Value) -> Result<Self> {
        let text = |key: &str| {
            row[key]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| moss_module_sdk::Error::new("Invalid meeting row"))
        };
        Ok(Self {
            id: text("id")?,
            title: text("title")?,
            notes: text("personal_notes")?,
            revision: row["notes_revision"]
                .as_i64()
                .ok_or_else(|| moss_module_sdk::Error::new("Invalid meeting row"))?,
            created_at: iso(&row["created_at"])?,
            updated_at: iso(&row["updated_at"])?,
        })
    }
    pub fn dto(&self) -> Value {
        json!({"id":self.id,"title":self.title,"personalNotes":self.notes,
            "notesRevision":self.revision,"createdAt":self.created_at,"updatedAt":self.updated_at})
    }
}

pub struct Records<'a, H: Host + ?Sized> {
    host: &'a H,
}
impl<'a, H: Host + ?Sized> Records<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self { host }
    }
    fn client(&self) -> Client<'a, H> {
        Client(self.host)
    }
    fn now(&self) -> Result<String> {
        let context = self.host.call("context", "read", "call", json!({}))?;
        let now = context["now"]
            .as_str()
            .ok_or_else(|| moss_module_sdk::Error::new("Invalid host time"))?;
        iso(&Value::String(now.to_owned()))
    }
    fn row(&self, id: &str) -> Result<Option<Value>> {
        let mut query = Query::select(Filter::eq("id", id));
        query.limit = Some(1);
        Ok(self.client().query(RECORDS, &query)?.into_iter().next())
    }

    pub fn create(&self, mut body: Value) -> Result<Response> {
        if let Err(failure) = strict_object(
            "body",
            &mut body,
            &["requestKey", "title"],
            &[
                ("requestKey", Kind::Uuid),
                ("title", Kind::Text { min: 1, max: 240 }),
            ],
            0,
        ) {
            return Ok(bad_request(failure));
        }
        let (key, raw) = (body["requestKey"].as_str().unwrap_or_default(), body["title"].as_str().unwrap_or_default());
        if !bounded(raw, 240, true) {
            return Ok(invalid());
        }
        let title = js_trim(raw);
        let mut insert = Query::insert(values(vec![("request_key", json!(key)), ("title", json!(title))]));
        insert.conflict = Conflict::Ignore;
        if let Some(row) = self.client().query(RECORDS, &insert)?.first() {
            let meeting = Snapshot::from_row(row)?.dto();
            return Ok(Response::new(201, json!({"created":true,"meeting":meeting})));
        }
        // A separate statement sees the row a concurrent request committed first.
        let mut find = Query::select(Filter::eq("request_key", key));
        find.limit = Some(1);
        let existing = self
            .client()
            .query(RECORDS, &find)?
            .into_iter()
            .next()
            .ok_or_else(|| moss_module_sdk::Error::new("Meeting request vanished"))?;
        if existing["creation_title"].as_str() != Some(title) {
            return Ok(code(409, "meeting_request_conflict"));
        }
        // Replay the original creation snapshot, not later edits.
        let mut snapshot = Snapshot::from_row(&existing)?;
        snapshot.title = title.to_owned();
        snapshot.notes = String::new();
        snapshot.revision = 0;
        snapshot.updated_at = snapshot.created_at.clone();
        Ok(Response::new(200, json!({"created":false,"meeting":snapshot.dto()})))
    }

    pub fn list(&self, request: &RouteRequest) -> Result<Response> {
        let mut query_object = Value::Object(request.query.clone().into_iter().collect::<Map<_, _>>());
        if let Err(failure) = strict_object(
            "querystring",
            &mut query_object,
            &[],
            &[
                ("limit", Kind::Int { min: 1, max: 100 }),
                ("beforeId", Kind::Uuid),
                ("beforeCreatedAt", Kind::Text { min: 0, max: usize::MAX }),
            ],
            0,
        ) {
            return Ok(bad_request(failure));
        }
        let (id, at) = (query_object.get("beforeId"), query_object.get("beforeCreatedAt"));
        if id.is_some() && at.is_none() {
            return Ok(bad_request("querystring must have property beforeCreatedAt when property beforeId is present".into()));
        }
        if at.is_some() && id.is_none() {
            return Ok(bad_request("querystring must have property beforeId when property beforeCreatedAt is present".into()));
        }
        let limit = query_object.get("limit").and_then(Value::as_u64).unwrap_or(50) as u32;
        let mut query = Query::select(Filter::All);
        if let (Some(id), Some(at)) = (id.and_then(Value::as_str), at.and_then(Value::as_str)) {
            if DateTime::parse_from_rfc3339(at).is_err() {
                return Ok(bad_request("querystring/beforeCreatedAt must match format \"date-time\"".into()));
            }
            if !is_iso_millis(at) {
                return Ok(invalid());
            }
            query.filter = Filter::Or {
                filters: vec![
                    Filter::Compare { column: "created_at".into(), op: Compare::Lt, value: json!(at) },
                    Filter::And {
                        filters: vec![
                            Filter::eq("created_at", at),
                            Filter::Compare { column: "id".into(), op: Compare::Lt, value: json!(id) },
                        ],
                    },
                ],
            };
        }
        query.order = vec![
            Order { column: "created_at".into(), descending: true },
            Order { column: "id".into(), descending: true },
        ];
        query.limit = Some(limit);
        let meetings = self
            .client()
            .query(RECORDS, &query)?
            .iter()
            .map(|row| Snapshot::from_row(row).map(|s| s.dto()))
            .collect::<Result<Vec<_>>>()?;
        Ok(Response::new(200, json!({"meetings":meetings})))
    }

    pub fn get(&self, request: &RouteRequest) -> Result<Response> {
        let id = match id_params(request) {
            Ok(id) => id,
            Err(failure) => return Ok(bad_request(failure)),
        };
        Ok(match self.row(&id)? {
            Some(row) => Response::new(200, json!({"meeting":Snapshot::from_row(&row)?.dto()})),
            None => code(404, "meeting_not_found"),
        })
    }

    /// Permanent. A missing record and one that belongs to someone else answer the same way.
    /// Cascading foreign keys remove notes receipts and every later part's rows in this transaction.
    pub fn delete(&self, request: &RouteRequest) -> Result<Response> {
        let id = match id_params(request) {
            Ok(id) => id,
            Err(failure) => return Ok(bad_request(failure)),
        };
        self.client().query(RECORDS, &Query::delete(Filter::eq("id", id)))?;
        Ok(Response::new(204, Value::Null))
    }

    pub fn put_title(&self, request: &RouteRequest) -> Result<Response> {
        let id = match id_params(request) {
            Ok(id) => id,
            Err(failure) => return Ok(bad_request(failure)),
        };
        let mut body = request.body.clone();
        let text = Kind::Text { min: 1, max: 240 };
        if let Err(failure) = strict_object(
            "body",
            &mut body,
            &["title", "expectedTitle"],
            &[("title", text), ("expectedTitle", text)],
            0,
        ) {
            return Ok(bad_request(failure));
        }
        let (raw, expected) = (
            body["title"].as_str().unwrap_or_default(),
            body["expectedTitle"].as_str().unwrap_or_default(),
        );
        if !bounded(raw, 240, true) || !bounded(expected, 240, true) {
            return Ok(invalid());
        }
        let title = js_trim(raw);
        let Some(row) = self.row(&id)? else {
            return Ok(code(404, "meeting_not_found"));
        };
        let current = Snapshot::from_row(&row)?;
        if current.title != expected && current.title != title {
            return Ok(Response::new(
                409,
                json!({"code":"meeting_title_conflict","status":"conflict","meeting":current.dto()}),
            ));
        }
        self.mark_user_title(&id, &current.title)?;
        if current.title == title {
            return Ok(Response::new(200, json!({"status":"saved","meeting":current.dto()})));
        }
        // The expected current title is part of the update filter, so a concurrent rename
        // that landed first leaves this update with no row and the caller sees the conflict.
        let updated = self.client().query(
            RECORDS,
            &Query::update(
                Filter::And {
                    filters: vec![
                        Filter::eq("id", id.as_str()),
                        Filter::eq("title", current.title.as_str()),
                    ],
                },
                values(vec![("title", json!(title)), ("updated_at", json!(self.now()?))]),
            ),
        )?;
        if let Some(row) = updated.first() {
            return Ok(Response::new(200, json!({"status":"saved","meeting":Snapshot::from_row(row)?.dto()})));
        }
        let Some(row) = self.row(&id)? else {
            return Ok(code(404, "meeting_not_found"));
        };
        let now = Snapshot::from_row(&row)?;
        if now.title == title {
            return Ok(Response::new(200, json!({"status":"saved","meeting":now.dto()})));
        }
        Ok(Response::new(
            409,
            json!({"code":"meeting_title_conflict","status":"conflict","meeting":now.dto()}),
        ))
    }

    /// A person's own rename stops later automatic titling. The metadata row belongs to recording
    /// identity (a later part) but exists in the migrated schema.
    fn mark_user_title(&self, id: &str, title: &str) -> Result<()> {
        let source = if title == "Untitled meeting" { "automatic" } else { "user" };
        let mut seed = Query::insert(values(vec![("meeting_id", json!(id)), ("title_source", json!(source))]));
        seed.conflict = Conflict::Ignore;
        self.client().query(METADATA, &seed)?;
        let mut find = Query::select(Filter::eq("meeting_id", id));
        find.limit = Some(1);
        let Some(row) = self.client().query(METADATA, &find)?.into_iter().next() else {
            return Ok(());
        };
        let revision = row["revision"].as_i64().unwrap_or(0);
        self.client().query(
            METADATA,
            &Query::update(
                Filter::And {
                    filters: vec![Filter::eq("meeting_id", id), Filter::eq("revision", revision)],
                },
                values(vec![("title_source", json!("user")), ("revision", json!(revision + 1))]),
            ),
        )?;
        Ok(())
    }

    pub fn put_notes(&self, request: &RouteRequest) -> Result<Response> {
        let id = match id_params(request) {
            Ok(id) => id,
            Err(failure) => return Ok(bad_request(failure)),
        };
        let mut body = request.body.clone();
        if let Err(failure) = strict_object(
            "body",
            &mut body,
            &["requestKey", "expectedRevision", "personalNotes"],
            &[
                ("requestKey", Kind::Uuid),
                ("expectedRevision", Kind::Int { min: 0, max: 2_147_483_646 }),
                ("personalNotes", Kind::Text { min: 0, max: 64_000 }),
            ],
            0,
        ) {
            return Ok(bad_request(failure));
        }
        let key = body["requestKey"].as_str().unwrap_or_default().to_owned();
        let expected = crate::schema::int_value(&body["expectedRevision"]).unwrap_or_default();
        let notes = body["personalNotes"].as_str().unwrap_or_default().to_owned();
        if !bounded(&notes, 64_000, false) {
            return Ok(invalid());
        }
        let Some(row) = self.row(&id)? else {
            return Ok(code(404, "meeting_not_found"));
        };
        if let Some(done) = self.replay(&row, &id, &key, expected, &notes)? {
            return Ok(done);
        }
        let current = Snapshot::from_row(&row)?;
        if current.revision != expected {
            return Ok(Self::notes_conflict(&current));
        }
        let now = self.now()?;
        // The revision in the filter makes this a compare and swap. If a concurrent request
        // committed first, no row matches and the answer is decided from the fresh state.
        let updated = self.client().query(
            RECORDS,
            &Query::update(
                Filter::And {
                    filters: vec![Filter::eq("id", id.as_str()), Filter::eq("notes_revision", expected)],
                },
                values(vec![
                    ("personal_notes", json!(notes)),
                    ("notes_revision", json!(expected + 1)),
                    ("updated_at", json!(now)),
                ]),
            ),
        )?;
        let Some(updated) = updated.first() else {
            let fresh = self
                .row(&id)?
                .ok_or_else(|| moss_module_sdk::Error::new("Meeting vanished"))?;
            if let Some(done) = self.replay(&fresh, &id, &key, expected, &notes)? {
                return Ok(done);
            }
            return Ok(Self::notes_conflict(&Snapshot::from_row(&fresh)?));
        };
        let saved = Snapshot::from_row(updated)?;
        self.client().query(
            NOTE_WRITES,
            &Query::insert(values(vec![
                ("meeting_id", json!(id)),
                ("request_key", json!(key)),
                ("expected_revision", json!(expected)),
                ("personal_notes", json!(notes)),
                ("saved_at", json!(saved.updated_at)),
            ])),
        )?;
        Ok(Response::new(
            200,
            json!({"status":"saved","replayed":false,"meeting":saved.dto()}),
        ))
    }

    fn notes_conflict(current: &Snapshot) -> Response {
        Response::new(
            409,
            json!({"code":"meeting_notes_conflict","status":"conflict","meeting":current.dto()}),
        )
    }

    /// A stored receipt answers a repeated key. The same input gets the original result, and
    /// different input is a conflict.
    fn replay(&self, row: &Value, id: &str, key: &str, expected: i64, notes: &str) -> Result<Option<Response>> {
        let mut find = Query::select(Filter::And {
            filters: vec![Filter::eq("meeting_id", id), Filter::eq("request_key", key)],
        });
        find.limit = Some(1);
        let Some(receipt) = self.client().query(NOTE_WRITES, &find)?.into_iter().next() else {
            return Ok(None);
        };
        let saved_revision = receipt["expected_revision"].as_i64().unwrap_or(-1);
        if saved_revision != expected || receipt["personal_notes"].as_str() != Some(notes) {
            return Ok(Some(code(409, "meeting_request_conflict")));
        }
        let mut snapshot = Snapshot::from_row(row)?;
        snapshot.notes = notes.to_owned();
        snapshot.revision = saved_revision + 1;
        snapshot.updated_at = iso(&receipt["saved_at"])?;
        Ok(Some(Response::new(
            200,
            json!({"status":"saved","replayed":true,"meeting":snapshot.dto()}),
        )))
    }
}
