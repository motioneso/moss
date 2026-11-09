//! People persistence through the shared typed-query port. A repository belongs to one
//! invocation; its caller must finalize the host call (and its transaction) exactly once.
//! Canonical-note mutations must be coordinated by the notes service, not exposed directly.
use moss_module_sdk::{
    query::{Compare, Conflict, Filter, Order, Query},
    Error, Host, Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const PEOPLE: &str = "app.person_context_people";
pub const IDENTITIES: &str = "app.person_context_identities";
pub const LINKS: &str = "app.person_context_links";
pub const LINK_SOURCES: &str = "app.person_context_link_sources";
pub const CANDIDATES: &str = "app.person_context_match_candidates";
pub const EVENTS: &str = "app.person_context_events";
pub const INDEXING: &str = "app.person_context_indexing_state";
pub const TABLES: [&str; 7] = [
    PEOPLE,
    IDENTITIES,
    LINKS,
    LINK_SOURCES,
    CANDIDATES,
    EVENTS,
    INDEXING,
];

pub struct Repository<'a, H: Host + ?Sized> {
    pub(crate) host: &'a H,
}
pub struct PersonProjection<'a> {
    pub id: &'a str,
    pub display_name: &'a str,
    pub relationship: Option<&'a str>,
    pub context: Option<&'a str>,
    pub status: &'a str,
    pub confidence: f64,
}
impl<'a, H: Host + ?Sized> Repository<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self { host }
    }

    pub(crate) fn query(&self, table: &str, query: Query) -> Result<Vec<Value>> {
        let nulls_first: Vec<_> = query
            .order
            .iter()
            .filter(|order| order.descending)
            .map(|order| order.column.as_str())
            .collect();
        let mut parameters = serde_json::to_value(&query)?;
        if !nulls_first.is_empty() {
            parameters["nullsFirst"] = json!(nulls_first);
        }
        // The port has already decoded every row into a JSON value. Rebuilding
        // Vec<Value> through serde walks and reallocates the entire result again.
        match self.host.call("db", "query", table, parameters)? {
            Value::Array(rows) => Ok(rows),
            _ => Err(Error::new("Invalid host response")),
        }
    }
    /// Page instead of silently truncating at the host's thousand-row cap. The host
    /// transaction keeps a single invocation. Callers supply the legacy ordering;
    /// some legacy lookups leave ties unspecified and must not gain an ID tie-break.
    pub(crate) fn select(
        &self,
        table: &str,
        filter: Filter,
        order: Vec<Order>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>> {
        let mut out = vec![];
        loop {
            let count = limit.map_or(1000, |n| n.saturating_sub(out.len() as u32).min(1000));
            if count == 0 {
                break;
            }
            let query = Query {
                filter: owned(filter.clone()),
                order: order.clone(),
                limit: Some(count),
                offset: out.len() as u32,
                ..Query::default()
            };
            let rows = self.query(table, query)?;
            let more = rows.len() == count as usize;
            out.extend(rows);
            if !more {
                break;
            }
        }
        Ok(out)
    }
    pub(crate) fn one(&self, table: &str, filter: Filter) -> Result<Option<Value>> {
        Ok(self
            .select(table, filter, vec![], Some(1))?
            .into_iter()
            .next())
    }
    pub fn person(&self, id: &str) -> Result<Value> {
        self.one(PEOPLE, Filter::eq("id", id))?
            .map(|r| person_response(&r))
            .ok_or_else(|| Error::new("Person not found"))
    }
    pub fn detail(&self, id: &str) -> Result<Value> {
        let mut person = self.person(id)?;
        person["identities"] = json!(self.identities(id)?);
        person["recentLinks"] = json!(self.links(id, None, None, Some(20))?);
        Ok(person)
    }
    pub fn resolve(&self, query: &str) -> Result<Option<Value>> {
        let lowered = crate::matching::normalize_identity("email_address", query);
        let exact = |column: &str| Filter::Compare {
            column: column.into(),
            op: Compare::LowerEq,
            value: json!(lowered),
        };
        if let Some(identity) = self.one(IDENTITIES, exact("normalized_value"))? {
            if let Some(id) = identity["person_id"].as_str() {
                return self.person(id).map(Some);
            }
        }
        Ok(self
            .select(
                PEOPLE,
                exact("display_name"),
                orders(&[("created_at", false), ("id", false)]),
                Some(1),
            )?
            .first()
            .map(person_response))
    }
    pub fn list_people(
        &self,
        status: Option<&str>,
        search: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>> {
        let mut filters = vec![Filter::All];
        if let Some(status) = status.filter(|s| !s.is_empty()) {
            filters.push(Filter::eq("status", status));
        }
        if let Some(search) = search.filter(|s| !s.is_empty()) {
            // Preserve the legacy prefix pattern, including its SQL wildcard behavior.
            filters.push(Filter::Compare {
                column: "display_name".into(),
                op: Compare::ILike,
                value: json!(format!("{search}%")),
            });
        }
        Ok(self
            .select(
                PEOPLE,
                and(filters),
                orders(&[("display_name", false), ("id", false)]),
                limit.filter(|n| *n != 0),
            )?
            .iter()
            .map(person_response)
            .collect())
    }
    pub fn identities(&self, person_id: &str) -> Result<Vec<Value>> {
        Ok(self
            .select(
                IDENTITIES,
                Filter::eq("person_id", person_id),
                orders(&[("last_seen_at", true), ("id", false)]),
                None,
            )?
            .iter()
            .map(identity_response)
            .collect())
    }
    pub fn links(
        &self,
        person_id: &str,
        source: Option<&str>,
        kind: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<Value>> {
        let mut filters = vec![Filter::eq("person_id", person_id)];
        if let Some(source) = source.filter(|s| !s.is_empty()) {
            filters.push(Filter::eq("source_kind", source));
        }
        if let Some(kind) = kind.filter(|s| !s.is_empty()) {
            filters.push(Filter::eq("link_kind", kind));
        }
        Ok(self
            .select(
                LINKS,
                and(filters),
                orders(&[("occurred_at", true), ("created_at", true), ("id", false)]),
                limit.filter(|n| *n != 0),
            )?
            .iter()
            .map(link_response)
            .collect())
    }
    pub fn list_email_identity_values(&self) -> Result<Vec<String>> {
        Ok(self
            .select(
                IDENTITIES,
                Filter::eq("identity_kind", "email_address"),
                orders(&[("id", false)]),
                None,
            )?
            .iter()
            .filter_map(|r| r["normalized_value"].as_str().map(str::to_owned))
            .collect())
    }
    pub(crate) fn now(&self) -> Result<String> {
        self.host.call("context", "read", "call", json!({}))?["now"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::new("Invalid call context"))
    }
    pub(crate) fn insert(&self, table: &str, values: Value) -> Result<Value> {
        first(self.query(table, Query::insert(fields(values)?))?)
    }
    pub(crate) fn update(&self, table: &str, filter: Filter, values: Value) -> Result<Vec<Value>> {
        self.query(table, Query::update(owned(filter), fields(values)?))
    }
    pub(crate) fn upsert(
        &self,
        table: &str,
        columns: &[&str],
        initial: Value,
        update: Value,
    ) -> Result<Value> {
        let mut query = Query::insert(fields(initial)?);
        query.conflict = Conflict::Update {
            columns: columns.iter().map(|s| (*s).to_owned()).collect(),
            values: fields(update)?,
        };
        first(self.query(table, query)?)
    }
    /// This is a projection operation, never a replacement for a canonical note write.
    pub fn project_person(&self, projection: &PersonProjection<'_>) -> Result<Value> {
        let PersonProjection {
            id,
            display_name,
            relationship,
            context,
            status,
            confidence,
        } = *projection;
        let now = self.now()?;
        let values = json!({"display_name":display_name,"relationship_summary":relationship,"context_summary":context,"status":status,"confidence":confidence,"archived_at":if status == "archived" {json!(now)} else {Value::Null},"updated_at":now});
        let mut initial = values.clone();
        initial["id"] = json!(id);
        initial["created_at"] = json!(now);
        Ok(person_response(&self.upsert(
            PEOPLE,
            &["id"],
            initial,
            values,
        )?))
    }
    pub fn find_or_create_person(&self, name: &str) -> Result<Value> {
        let filter = and(vec![
            Filter::eq("display_name", name),
            Filter::Compare {
                column: "status".into(),
                op: Compare::Ne,
                value: json!("merged"),
            },
        ]);
        if let Some(row) = self.one(PEOPLE, filter)? {
            return Ok(person_response(&row));
        }
        let now = self.now()?;
        Ok(person_response(&self.insert(PEOPLE, json!({"display_name":name,"status":"active","confidence":0.5,"created_at":now,"updated_at":now}))?))
    }
    /// Legacy HTTP fallback when a canonical note is absent or unavailable.
    /// Retains summaries, confidence and archive metadata that a note projection replaces.
    pub fn update_projection(&self, person_id: &str, patch: &Value) -> Result<Value> {
        let mut values = json!({"updated_at":self.now()?});
        for (key, column) in [
            ("displayName", "display_name"),
            ("relationshipSummary", "relationship_summary"),
            ("contextSummary", "context_summary"),
            ("status", "status"),
        ] {
            if let Some(value) = patch.get(key) {
                values[column] = value.clone();
            }
        }
        Ok(person_response(&first(self.update(
            PEOPLE,
            Filter::eq("id", person_id),
            values,
        )?)?))
    }
    pub fn delete_note_identities(&self, person_id: &str) -> Result<()> {
        self.query(
            IDENTITIES,
            Query::delete(owned(and(vec![
                Filter::eq("person_id", person_id),
                Filter::eq("source_kind", "note"),
            ]))),
        )?;
        Ok(())
    }
    /// Indexing uses the unchanged three-column key; no artificial id is introduced.
    pub fn indexing_state(&self, source: &str, hash: &str) -> Result<Option<Value>> {
        self.one(
            INDEXING,
            and(vec![
                Filter::eq("source", source),
                Filter::eq("source_ref_hash", hash),
            ]),
        )
    }
    pub fn save_indexing_state(
        &self,
        source: &str,
        hash: &str,
        source_ref: &str,
        patch: Value,
    ) -> Result<Value> {
        let now = self.now()?;
        let mut values = json!({"source_ref":source_ref,"last_indexed_at":null,"last_source_version":null,"pending_source_version":null,"last_enqueued_at":null,"last_started_at":null,"last_finished_at":null,"failure_count":0,"updated_at":now});
        let patch = fields(patch)?;
        for (key, value) in patch {
            if !matches!(
                key.as_str(),
                "last_indexed_at"
                    | "last_source_version"
                    | "pending_source_version"
                    | "last_enqueued_at"
                    | "last_started_at"
                    | "last_finished_at"
                    | "failure_count"
            ) {
                return Err(Error::new("Invalid indexing field"));
            }
            values[&key] = value;
        }
        let mut initial = values.clone();
        initial["source"] = json!(source);
        initial["source_ref_hash"] = json!(hash);
        initial["created_at"] = json!(now);
        self.upsert(
            INDEXING,
            &["owner_user_id", "source", "source_ref_hash"],
            initial,
            values,
        )
    }
}

pub(crate) fn fields(value: Value) -> Result<BTreeMap<String, Value>> {
    value
        .as_object()
        .cloned()
        .map(|o| o.into_iter().collect())
        .ok_or_else(|| Error::new("Expected field values"))
}
pub(crate) fn first(rows: Vec<Value>) -> Result<Value> {
    rows.into_iter()
        .next()
        .ok_or_else(|| Error::new("People row not found"))
}
pub(crate) fn and(filters: Vec<Filter>) -> Filter {
    Filter::And { filters }
}
pub(crate) fn owned(filter: Filter) -> Filter {
    and(vec![Filter::Owned, filter])
}
pub(crate) fn orders(fields: &[(&str, bool)]) -> Vec<Order> {
    fields
        .iter()
        .map(|(name, descending)| Order {
            column: (*name).into(),
            descending: *descending,
        })
        .collect()
}

pub(crate) fn response(row: &Value, fields: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for field in fields {
        let mut name = String::new();
        let mut upper = false;
        for c in field.chars() {
            if c == '_' {
                upper = true;
            } else if upper {
                name.push(c.to_ascii_uppercase());
                upper = false;
            } else {
                name.push(c);
            }
        }
        let mut value = row[*field].clone();
        // node-postgres returns NUMERIC(4,2) as text. The legacy repository's
        // TypeScript assertion does not convert it, including on Type.Any routes.
        if *field == "confidence" {
            if let Some(number) = value.as_f64() {
                value = json!(format!("{number:.2}"));
            }
        }
        if field.ends_with("_at") {
            if let Some(text) = value.as_str() {
                if let Ok(time) = chrono::DateTime::parse_from_rfc3339(text) {
                    value = json!(time
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                }
            }
        }
        result.insert(name, value);
    }
    Value::Object(result)
}
pub(crate) fn person_response(row: &Value) -> Value {
    response(
        row,
        &[
            "id",
            "owner_user_id",
            "display_name",
            "relationship_summary",
            "context_summary",
            "status",
            "confidence",
            "memory_entity_id",
            "merged_into_person_id",
            "archived_at",
            "merged_at",
            "created_at",
            "updated_at",
        ],
    )
}
pub(crate) fn identity_response(row: &Value) -> Value {
    response(
        row,
        &[
            "id",
            "owner_user_id",
            "person_id",
            "identity_kind",
            "source_kind",
            "display_value",
            "source_ref_hash",
            "status",
            "confidence",
            "provenance",
            "first_seen_at",
            "last_seen_at",
            "created_at",
            "updated_at",
        ],
    )
}
pub(crate) fn link_response(row: &Value) -> Value {
    response(
        row,
        &[
            "id",
            "owner_user_id",
            "person_id",
            "source_kind",
            "source_ref_hash",
            "source_label",
            "link_kind",
            "summary",
            "occurred_at",
            "source_updated_at",
            "confidence",
            "provenance",
            "created_at",
            "updated_at",
        ],
    )
}
