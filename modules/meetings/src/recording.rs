//! Recording types and the recording identity of one meeting. Every call shares one host
//! invocation, which owns the transaction and runs as the signed-in person under row security.
use crate::js::utf16_len;
use crate::records::{iso, Records, METADATA};
use crate::schema::{id_params, int_value, strict_object, Failure, Kind};
use crate::text::{is_type_id, js_trim};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Client, Host, Response, Result, RouteRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const TYPES: &str = "app.meeting_recording_types";
const LOCK: &str = "meetings.recording-types";
const TEMPLATES: [&str; 4] = ["general", "one-to-one", "project-review", "interview"];

pub(crate) fn code(status: u16, code: &str) -> Response {
    Response::new(status, json!({ "code": code }))
}
fn bad_request(failure: Failure) -> Response {
    Response::new(400, json!({ "error": failure }))
}
fn values(pairs: Vec<(&str, Value)>) -> BTreeMap<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
}

/// One recording type, in the key order the old app stored.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingType {
    pub id: String,
    pub name: String,
    pub description: String,
    pub template_id: String,
    pub retired: bool,
}

#[derive(Clone, Serialize)]
pub struct Configuration {
    pub revision: i64,
    pub types: Vec<RecordingType>,
}

fn default_types() -> Vec<RecordingType> {
    let make = |id: &str, name: &str, description: &str| RecordingType {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        template_id: "general".into(),
        retired: false,
    };
    vec![
        make("work-meeting", "Work meeting", "Work discussions, decisions and action items."),
        make("appointment", "Appointment", "A scheduled appointment or consultation."),
        make("brain-dump", "Brain dump", "Thinking aloud, loose thoughts and grouped ideas."),
        make("conversation", "Conversation", "An informal conversation with other people."),
        make("idea", "Idea", "A focused idea or proposal to develop."),
        make("other", "Other", "A recording that does not fit another active type."),
    ]
}

/// Why a request is refused, in the old app's `{code}` shape.
pub struct Refusal(pub u16, pub &'static str);
impl Refusal {
    pub fn response(&self) -> Response {
        code(self.0, self.1)
    }
}
fn invalid() -> Refusal {
    Refusal(400, "recording_type_configuration_invalid")
}
fn too_large() -> Refusal {
    Refusal(400, "recording_type_configuration_too_large")
}

/// A JavaScript string length check: trimmed, non-blank, no NUL, raw length in UTF-16 units.
fn text(value: &Value, max: usize) -> std::result::Result<String, Refusal> {
    let s = value.as_str().ok_or_else(invalid)?;
    if js_trim(s).is_empty() || s.contains('\0') || utf16_len(s) > max {
        return Err(invalid());
    }
    Ok(js_trim(s).to_owned())
}

fn exact<'v>(value: &'v Value, keys: &[&str]) -> std::result::Result<&'v serde_json::Map<String, Value>, Refusal> {
    let map = value.as_object().filter(|m| m.len() == keys.len() && keys.iter().all(|k| m.contains_key(*k)));
    map.ok_or_else(invalid)
}

/// Same rules and order as the old strict check that runs before the schema.
pub fn validate(value: &Value) -> std::result::Result<(i64, Vec<RecordingType>), Refusal> {
    let input = exact(value, &["expectedRevision", "types"])?;
    let expected = int_value(&input["expectedRevision"])
        .filter(|n| input["expectedRevision"].is_number() && (0..=2_147_483_646).contains(n))
        .ok_or_else(invalid)?;
    let list = input["types"].as_array().filter(|a| !a.is_empty()).ok_or_else(invalid)?;
    if list.len() > 32 {
        return Err(Refusal(400, "recording_type_limit"));
    }
    if serde_json::to_string(value).map_err(|_| invalid())?.len() > 65_536 {
        return Err(too_large());
    }
    let (mut ids, mut names, mut types) = (vec![], vec![], vec![]);
    for item in list {
        let type_ = exact(item, &["id", "name", "description", "templateId", "retired"])?;
        let id = type_["id"].as_str().filter(|s| is_type_id(s)).ok_or_else(invalid)?;
        let name = text(&type_["name"], 80)?;
        let description = text(&type_["description"], 500)?;
        if ids.contains(&id) || names.contains(&name.to_lowercase()) {
            return Err(invalid());
        }
        ids.push(id);
        names.push(name.to_lowercase());
        let template = type_["templateId"].as_str().filter(|t| TEMPLATES.contains(t)).ok_or_else(invalid)?;
        let retired = type_["retired"].as_bool().ok_or_else(invalid)?;
        types.push(RecordingType {
            id: id.into(),
            name,
            description,
            template_id: template.into(),
            retired,
        });
    }
    if types.iter().all(|t| t.retired) {
        return Err(invalid());
    }
    let pretty = serde_json::to_string_pretty(&Configuration { revision: expected + 1, types: types.clone() })
        .map_err(|_| invalid())?;
    if utf16_len(&pretty) > 12_000 {
        return Err(too_large());
    }
    Ok((expected, types))
}

pub struct Recording<'a, H: Host + ?Sized> {
    host: &'a H,
}
impl<'a, H: Host + ?Sized> Recording<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self { host }
    }
    fn client(&self) -> Client<'a, H> {
        Client(self.host)
    }

    /// The person's configuration. A read shares the lock and a save holds it exclusively.
    pub fn configuration(&self, exclusive: bool) -> Result<Configuration> {
        self.host.call("kv", if exclusive { "lock" } else { "get" }, LOCK, json!({}))?;
        let mut query = Query::select(Filter::Owned);
        query.limit = Some(1);
        Ok(match self.client().query(TYPES, &query)?.into_iter().next() {
            Some(row) => Configuration {
                revision: row["revision"].as_i64().unwrap_or(0),
                types: serde_json::from_str(row["types_json"].as_str().unwrap_or("[]"))?,
            },
            None => Configuration { revision: 0, types: default_types() },
        })
    }

    pub fn get_types(&self) -> Result<Response> {
        Ok(Response::new(200, serde_json::to_value(self.configuration(false)?)?))
    }

    pub fn put_types(&self, body: &Value) -> Result<Response> {
        let (expected, types) = match validate(body) {
            Ok(ok) => ok,
            Err(refusal) => return Ok(refusal.response()),
        };
        let current = self.configuration(true)?;
        if expected != current.revision {
            return Ok(code(409, "recording_type_configuration_conflict"));
        }
        let removed = current.types.iter().any(|t| !types.iter().any(|n| n.id == t.id));
        let new_retired = types.iter().any(|t| t.retired && !current.types.iter().any(|c| c.id == t.id));
        if removed || new_retired {
            return Ok(invalid().response());
        }
        if current.types == types {
            return Ok(Response::new(200, serde_json::to_value(&current)?));
        }
        let next = Configuration { revision: current.revision + 1, types };
        let mut upsert = Query::insert(values(vec![
            ("revision", json!(next.revision)),
            ("types_json", json!(serde_json::to_string(&next.types)?)),
        ]));
        upsert.conflict = Conflict::Update {
            columns: vec!["owner_user_id".into()],
            values: values(vec![
                ("revision", json!(next.revision)),
                ("types_json", json!(serde_json::to_string(&next.types)?)),
            ]),
        };
        self.client().query(TYPES, &upsert)?;
        Ok(Response::new(200, serde_json::to_value(&next)?))
    }

    fn metadata_row(&self, id: &str) -> Result<Option<Value>> {
        let mut query = Query::select(Filter::eq("meeting_id", id));
        query.limit = Some(1);
        Ok(self.client().query(METADATA, &query)?.into_iter().next())
    }

    /// Creates the metadata row on first use. A person's own title wins over automatic titling.
    pub(crate) fn ensure(&self, id: &str, title: &str) -> Result<Option<Value>> {
        let source = if title == "Untitled meeting" { "automatic" } else { "user" };
        let mut seed = Query::insert(values(vec![("meeting_id", json!(id)), ("title_source", json!(source))]));
        seed.conflict = Conflict::Ignore;
        self.client().query(METADATA, &seed)?;
        self.metadata_row(id)
    }

    pub fn get(&self, request: &RouteRequest) -> Result<Response> {
        let id = match id_params(request) {
            Ok(id) => id,
            Err(failure) => return Ok(bad_request(failure)),
        };
        if Records::new(self.host).row(&id)?.is_none() {
            return Ok(code(404, "meeting_not_found"));
        }
        let metadata = match self.metadata_row(&id)? {
            Some(row) => dto(&row)?,
            None => Value::Null,
        };
        let configuration = serde_json::to_value(self.configuration(false)?)?;
        Ok(Response::new(200, json!({"metadata": metadata, "configuration": configuration})))
    }

    pub fn put_type(&self, request: &RouteRequest) -> Result<Response> {
        let id = match id_params(request) {
            Ok(id) => id,
            Err(failure) => return Ok(bad_request(failure)),
        };
        let mut body = request.body.clone();
        // The old route strips unknown properties instead of refusing them.
        if let Some(map) = body.as_object_mut() {
            map.retain(|key, _| key == "expectedRevision" || key == "typeId");
        }
        if let Err(failure) = strict_object(
            "body",
            &mut body,
            &["expectedRevision", "typeId"],
            &[
                ("expectedRevision", Kind::Int { min: 0, max: 2_147_483_646 }),
                ("typeId", Kind::TypeId),
            ],
            0,
        ) {
            return Ok(bad_request(failure));
        }
        let expected = int_value(&body["expectedRevision"]).unwrap_or_default();
        let type_id = body["typeId"].as_str().unwrap_or_default();
        let Some(record) = Records::new(self.host).row(&id)? else {
            return Ok(code(404, "meeting_not_found"));
        };
        let available = self.configuration(false)?.types.iter().any(|t| t.id == type_id && !t.retired);
        if !available {
            return Ok(code(400, "recording_type_unavailable"));
        }
        let title = record["title"].as_str().unwrap_or_default();
        let Some(current) = self.ensure(&id, title)? else {
            return Ok(code(404, "meeting_not_found"));
        };
        if current["revision"].as_i64() != Some(expected) {
            return Ok(code(409, "recording_revision_conflict"));
        }
        // The revision in the filter makes this a compare and swap against a concurrent save.
        let updated = self.client().query(
            METADATA,
            &Query::update(
                Filter::And {
                    filters: vec![Filter::eq("meeting_id", id.as_str()), Filter::eq("revision", expected)],
                },
                values(vec![
                    ("type_id", json!(type_id)),
                    ("type_source", json!("user")),
                    ("revision", json!(expected + 1)),
                ]),
            ),
        )?;
        let Some(row) = updated.first() else {
            return Ok(code(409, "recording_revision_conflict"));
        };
        Ok(Response::new(200, json!({"metadata": dto(row)?})))
    }

    /// Writes the metadata row for a new manual transcript.
    pub(crate) fn create(&self, id: &str, title_source: &str, type_id: Option<&str>, recorded_at: Option<&str>) -> Result<()> {
        self.client().query(
            METADATA,
            &Query::insert(values(vec![
                ("meeting_id", json!(id)),
                ("title_source", json!(title_source)),
                ("type_id", json!(type_id)),
                ("type_source", json!(if type_id.is_none() { "automatic" } else { "user" })),
                ("source", json!("manual-transcript")),
                ("recorded_at", json!(recorded_at)),
            ])),
        )?;
        Ok(())
    }
}

/// What a person sees of one recording identity.
pub fn dto(row: &Value) -> Result<Value> {
    let text = |key: &str| row[key].clone();
    let recorded = match &row["recorded_at"] {
        Value::Null => Value::Null,
        at => Value::String(iso(at)?),
    };
    Ok(json!({"meetingId":text("meeting_id"),"revision":text("revision"),"typeId":text("type_id"),
        "typeSource":text("type_source"),"titleSource":text("title_source"),"side":text("side"),
        "confidence":text("confidence"),"reason":text("reason"),"recordedAt":recorded,
        "source":text("source"),"outputVersion":text("output_version")}))
}
