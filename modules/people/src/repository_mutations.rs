//! Projection mutations. Canonical notes and user actions are coordinated by the service.
use crate::repository::{
    and, first, identity_response, link_response, orders, response, Repository, CANDIDATES, EVENTS,
    IDENTITIES, LINKS, LINK_SOURCES, PEOPLE,
};
use moss_module_sdk::{
    query::{Conflict, Filter, Query},
    Error, Host, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityInput {
    pub person_id: Option<String>,
    pub identity_kind: String,
    pub source_kind: String,
    pub normalized_value: String,
    pub display_value: String,
    pub source_ref: Option<String>,
    pub source_ref_hash: Option<String>,
    pub status: Option<String>,
    pub confidence: Option<f64>,
    pub provenance: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkInput {
    pub person_id: String,
    pub source_kind: String,
    pub source_ref: String,
    pub source_ref_hash: String,
    pub link_kind: String,
    pub source_label: Option<String>,
    pub summary: Option<String>,
    pub occurred_at: Option<String>,
    pub source_updated_at: Option<String>,
    pub confidence: Option<f64>,
    pub provenance: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateInput {
    pub candidate_kind: String,
    pub primary_person_id: Option<String>,
    pub secondary_person_id: Option<String>,
    pub identity_id: Option<String>,
    pub suggested_display_name: Option<String>,
    pub reason_summary: Option<String>,
    pub confidence: Option<f64>,
    pub ids: Vec<String>,
}

impl<H: Host + ?Sized> Repository<'_, H> {
    pub fn identity(&self, id: &str) -> Result<Value> {
        self.one(IDENTITIES, Filter::eq("id", id))?
            .ok_or_else(|| Error::new("Identity not found"))
    }
    pub fn upsert_identity(&self, input: &IdentityInput) -> Result<Value> {
        if let Some(person) = &input.person_id {
            self.person(person)?;
        }
        let now = self.now()?;
        let status = input.status.as_deref().unwrap_or("active");
        let values = json!({"person_id":input.person_id,"identity_kind":input.identity_kind,"source_kind":input.source_kind,
            "normalized_value":input.normalized_value,"display_value":input.display_value,"source_ref":input.source_ref,
            "source_ref_hash":input.source_ref_hash,"status":status,"confidence":input.confidence.unwrap_or(0.5),
            "provenance":input.provenance.as_deref().unwrap_or("source"),"first_seen_at":now,"last_seen_at":now,"created_at":now,"updated_at":now});
        if status != "active"
            || !matches!(
                input.identity_kind.as_str(),
                "email_address" | "source_identity"
            )
        {
            return Ok(identity_response(&self.insert(IDENTITIES, values)?));
        }
        // The legacy index is partial. Conflict-ignore waits on a racing insert;
        // the subsequent owner-scoped update preserves first-seen/confidence/source.
        let mut insert = Query::insert(crate::repository::fields(values)?);
        insert.conflict = Conflict::Ignore;
        let rows = self.query(IDENTITIES, insert)?;
        if let Some(row) = rows.first() {
            return Ok(identity_response(row));
        }
        let rows = self.update(IDENTITIES, and(vec![
            Filter::eq("identity_kind", input.identity_kind.clone()), Filter::eq("source_kind", input.source_kind.clone()),
            Filter::eq("normalized_value", input.normalized_value.clone()), Filter::eq("status", "active"),
        ]), json!({"person_id":input.person_id,"display_value":input.display_value,"last_seen_at":now,"updated_at":now}))?;
        Ok(identity_response(&first(rows)?))
    }
    pub fn upsert_link(&self, input: &LinkInput) -> Result<Value> {
        self.person(&input.person_id)?;
        let now = self.now()?;
        let initial = json!({"person_id":input.person_id,"source_kind":input.source_kind,"source_ref":input.source_ref,
            "source_ref_hash":input.source_ref_hash,"link_kind":input.link_kind,"source_label":input.source_label,
            "summary":input.summary,"occurred_at":input.occurred_at,"source_updated_at":input.source_updated_at,
            "confidence":input.confidence.unwrap_or(0.5),"provenance":input.provenance.as_deref().unwrap_or("source"),
            "created_at":now,"updated_at":now});
        let update = json!({"source_label":input.source_label,"summary":input.summary,"source_updated_at":input.source_updated_at,"updated_at":now});
        Ok(link_response(&self.upsert(
            LINKS,
            &["owner_user_id", "person_id", "source_ref_hash", "link_kind"],
            initial,
            update,
        )?))
    }
    pub fn upsert_link_source(
        &self,
        link: &str,
        identity: Option<&str>,
        hash: &str,
        kind: &str,
        confidence: f64,
    ) -> Result<Value> {
        self.one(LINKS, Filter::eq("id", link))?
            .ok_or_else(|| Error::new("Link not found"))?;
        if let Some(id) = identity {
            self.identity(id)?;
        }
        let row = self.upsert(LINK_SOURCES, &["owner_user_id","link_id","source_ref_hash"],
            json!({"link_id":link,"identity_id":identity,"source_ref_hash":hash,"link_kind":kind,"confidence":confidence,"created_at":self.now()?}),
            json!({"confidence":confidence}))?;
        Ok(response(
            &row,
            &[
                "id",
                "owner_user_id",
                "link_id",
                "identity_id",
                "source_ref_hash",
                "link_kind",
                "confidence",
                "created_at",
            ],
        ))
    }
    pub fn upsert_candidate(&self, input: &CandidateInput) -> Result<Value> {
        for id in [&input.primary_person_id, &input.secondary_person_id]
            .into_iter()
            .flatten()
        {
            self.person(id)?;
        }
        if let Some(id) = &input.identity_id {
            self.identity(id)?;
        }
        let now = self.now()?;
        let row = self.upsert(CANDIDATES, &["owner_user_id","candidate_signature"],
            json!({"candidate_kind":input.candidate_kind,"status":"pending","primary_person_id":input.primary_person_id,
                "secondary_person_id":input.secondary_person_id,"identity_id":input.identity_id,"suggested_display_name":input.suggested_display_name,
                "reason_summary":input.reason_summary,"confidence":input.confidence.unwrap_or(0.5),
                "candidate_signature":crate::matching::candidate_signature(&input.candidate_kind,&input.ids),"created_at":now,"updated_at":now}),
            json!({"confidence":input.confidence.unwrap_or(0.5),"updated_at":now}))?;
        Ok(candidate_response(&row))
    }
    pub fn candidate(&self, id: &str) -> Result<Value> {
        self.one(CANDIDATES, Filter::eq("id", id))?
            .map(|r| candidate_response(&r))
            .ok_or_else(|| Error::new("Candidate not found"))
    }
    pub fn candidates(&self, status: Option<&str>) -> Result<Vec<Value>> {
        Ok(self
            .select(
                CANDIDATES,
                Filter::eq(
                    "status",
                    status.filter(|s| !s.is_empty()).unwrap_or("pending"),
                ),
                orders(&[("created_at", true), ("id", false)]),
                None,
            )?
            .iter()
            .map(candidate_response)
            .collect())
    }
    pub fn set_candidate_status(&self, id: &str, status: &str) -> Result<Value> {
        Ok(candidate_response(&first(self.update(
            CANDIDATES,
            Filter::eq("id", id),
            json!({"status":status,"updated_at":self.now()?}),
        )?)?))
    }
    pub fn event(
        &self,
        kind: &str,
        person: Option<&str>,
        secondary: Option<&str>,
        identity: Option<&str>,
        candidate: Option<&str>,
        hash: Option<&str>,
    ) -> Result<Value> {
        for id in [person, secondary].into_iter().flatten() {
            self.person(id)?;
        }
        if let Some(id) = identity {
            self.identity(id)?;
        }
        if let Some(id) = candidate {
            self.candidate(id)?;
        }
        let row = self.insert(EVENTS,json!({"event_kind":kind,"person_id":person,"secondary_person_id":secondary,
            "identity_id":identity,"candidate_id":candidate,"source_ref_hash":hash,"created_at":self.now()?}))?;
        Ok(response(
            &row,
            &[
                "id",
                "owner_user_id",
                "event_kind",
                "person_id",
                "secondary_person_id",
                "identity_id",
                "candidate_id",
                "source_ref_hash",
                "created_at",
            ],
        ))
    }
    pub fn merge(&self, primary: &str, secondary: &str) -> Result<Value> {
        self.person(primary)?;
        self.person(secondary)?;
        let now = self.now()?;
        for table in [IDENTITIES, LINKS] {
            self.update(
                table,
                Filter::eq("person_id", secondary),
                json!({"person_id":primary,"updated_at":now}),
            )?;
        }
        self.update(PEOPLE,Filter::eq("id",secondary),json!({"status":"merged","merged_into_person_id":primary,"merged_at":now,"updated_at":now}))?;
        self.event("merged", Some(primary), Some(secondary), None, None, None)?;
        self.person(primary)
    }
    pub fn split_identity(
        &self,
        identity: &str,
        target: Option<&str>,
        name: Option<&str>,
    ) -> Result<Value> {
        let row = self.identity(identity)?;
        let person = if let Some(id) = target.filter(|s| !s.is_empty()) {
            self.person(id)?
        } else {
            self.find_or_create_person(name.unwrap_or(row["display_value"].as_str().unwrap_or("")))?
        };
        let to = person["id"]
            .as_str()
            .ok_or_else(|| Error::new("Invalid person"))?;
        self.update(
            IDENTITIES,
            Filter::eq("id", identity),
            json!({"person_id":to,"updated_at":self.now()?}),
        )?;
        if let Some(from) = row["person_id"].as_str() {
            self.event("split", Some(from), Some(to), Some(identity), None, None)?;
        }
        self.event(
            "identity_linked",
            Some(to),
            None,
            Some(identity),
            None,
            None,
        )?;
        self.person(to)
    }
}

fn candidate_response(row: &Value) -> Value {
    response(
        row,
        &[
            "id",
            "owner_user_id",
            "candidate_kind",
            "status",
            "primary_person_id",
            "secondary_person_id",
            "identity_id",
            "suggested_display_name",
            "reason_summary",
            "confidence",
            "candidate_signature",
            "created_at",
            "updated_at",
        ],
    )
}
