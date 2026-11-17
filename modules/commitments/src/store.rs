//! Writes the extraction and judgement jobs make. Every call names a table of this package and
//! runs as the signed-in person, so the host applies the owner-only rules.
use crate::candidates::{CANDIDATES, SOURCES};
use crate::util::values;
use moss_module_sdk::{
    query::{Conflict, Filter, Order, Query},
    Client, Error, Host, Result,
};
use serde_json::{json, Value};

pub const STATE: &str = "app.commitment_extraction_state";
pub const JUDGEMENTS: &str = "app.commitment_email_thread_judgements";
/// A candidate keeps at most this many pieces of evidence.
const MAX_EVIDENCE_ROWS: usize = 5;
const EXCERPT_CAP: usize = 500;

pub fn now<H: Host + ?Sized>(host: &H) -> Result<String> {
    let context = host.call("context", "read", "call", json!({}))?;
    context["now"].as_str().map(str::to_owned).ok_or_else(|| Error::new("Host clock unavailable"))
}

fn one<H: Host + ?Sized>(host: &H, table: &str, filter: Filter) -> Result<Option<Value>> {
    let mut query = Query::select(filter);
    query.limit = Some(1);
    Ok(Client(host).query(table, &query)?.into_iter().next())
}

/// The fields every candidate write sets. Email candidates add the extra block.
pub struct Candidate<'a> {
    pub signature: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub due_local_date: Option<&'a str>,
    pub counterparty_label: Option<&'a str>,
    pub confidence: &'a str,
    pub suggested_handling: Option<&'a str>,
    pub email: Option<EmailFields<'a>>,
}

pub struct EmailFields<'a> {
    pub person_id: Option<&'a str>,
    pub address: Option<&'a str>,
    pub actions: Vec<Value>,
    pub why: Vec<String>,
    pub thread_ref: &'a str,
    pub last_judged_external_id: &'a str,
}

fn text(value: Option<&str>) -> Value {
    value.map(|v| json!(v)).unwrap_or(Value::Null)
}

/// A new sighting folds into the candidate with the same signature. A plain sighting only
/// counts. An email judgement refreshes the content, keeps a rejection or a "no action"
/// ruling, and otherwise reopens the candidate for review.
pub fn upsert_candidate<H: Host + ?Sized>(host: &H, c: &Candidate) -> Result<Value> {
    let at = now(host)?;
    let client = Client(host);
    for _ in 0..2 {
        if let Some(existing) = one(host, CANDIDATES, Filter::eq("candidate_signature", c.signature))? {
            let count = existing["source_count"].as_i64().unwrap_or(0) + 1;
            let mut changes = vec![
                ("source_count", json!(count)),
                ("last_seen_at", json!(at)),
                ("updated_at", json!(at)),
            ];
            if let Some(email) = &c.email {
                let kept = matches!(existing["status"].as_str(), Some("rejected" | "explicit_non_action"));
                changes.extend([
                    ("title", json!(c.title)),
                    ("due_local_date", text(c.due_local_date)),
                    ("counterparty_label", text(c.counterparty_label)),
                    ("confidence", json!(c.confidence)),
                    ("suggested_handling", text(c.suggested_handling)),
                    ("counterparty_person_id", text(email.person_id)),
                    ("counterparty_address", text(email.address)),
                    ("proposed_actions", json!(email.actions)),
                    ("why_lines", json!(email.why)),
                    ("last_judged_external_id", json!(email.last_judged_external_id)),
                    ("stale", json!(false)),
                ]);
                if !kept {
                    changes.push(("status", json!("pending_review")));
                }
            }
            let id = existing["id"].as_str().ok_or_else(|| Error::new("Invalid candidate row"))?;
            let rows = client.query(CANDIDATES, &Query::update(Filter::eq("id", id), values(changes)))?;
            return rows.into_iter().next().ok_or_else(|| Error::new("Candidate vanished"));
        }
        let mut fields = vec![
            ("candidate_signature", json!(c.signature)),
            ("kind", json!(c.kind)),
            ("title", json!(c.title)),
            ("due_local_date", text(c.due_local_date)),
            ("counterparty_label", text(c.counterparty_label)),
            ("confidence", json!(c.confidence)),
            ("suggested_handling", text(c.suggested_handling)),
            // A proposal always starts unreviewed and reaches no task list until the person accepts it.
            ("status", json!("pending_review")),
            ("source_count", json!(1)),
            ("first_seen_at", json!(at)),
            ("last_seen_at", json!(at)),
        ];
        if let Some(email) = &c.email {
            fields.extend([
                ("counterparty_person_id", text(email.person_id)),
                ("counterparty_address", text(email.address)),
                ("proposed_actions", json!(email.actions)),
                ("why_lines", json!(email.why)),
                ("thread_ref", json!(email.thread_ref)),
                ("last_judged_external_id", json!(email.last_judged_external_id)),
                ("stale", json!(false)),
            ]);
        }
        let mut insert = Query::insert(values(fields));
        insert.conflict = Conflict::Ignore;
        if let Some(row) = client.query(CANDIDATES, &insert)?.into_iter().next() {
            return Ok(row);
        }
    }
    Err(Error::new("Candidate could not be saved"))
}

/// One short, escaped piece of evidence for a candidate. The sixth piece is dropped.
pub fn add_evidence<H: Host + ?Sized>(
    host: &H,
    candidate_id: &str,
    source_kind: &str,
    source_ref: &str,
    source_version: i64,
    excerpt: &str,
    occurred_at: Option<&str>,
) -> Result<bool> {
    let client = Client(host);
    let owned = Filter::eq("candidate_id", candidate_id);
    let present = client.query(SOURCES, &Query::select(owned.clone()))?;
    let same = present.iter().find(|row| row["source_kind"] == source_kind && row["source_ref"] == source_ref);
    let cleaned: String = excerpt
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .chars()
        .take(EXCERPT_CAP)
        .collect();
    if let Some(row) = same {
        let id = row["id"].as_str().ok_or_else(|| Error::new("Invalid evidence row"))?;
        client.query(
            SOURCES,
            &Query::update(
                Filter::eq("id", id),
                values(vec![("source_version", json!(source_version)), ("evidence_excerpt", json!(cleaned))]),
            ),
        )?;
        return Ok(true);
    }
    if present.len() >= MAX_EVIDENCE_ROWS {
        return Ok(false);
    }
    client.query(
        SOURCES,
        &Query::insert(values(vec![
            ("candidate_id", json!(candidate_id)),
            ("source_kind", json!(source_kind)),
            ("source_ref", json!(source_ref)),
            ("source_version", json!(source_version)),
            ("evidence_excerpt", json!(cleaned)),
            ("occurred_at", text(occurred_at)),
        ])),
    )?;
    Ok(true)
}

pub fn extraction_state<H: Host + ?Sized>(host: &H, source_kind: &str) -> Result<Option<Value>> {
    one(host, STATE, Filter::eq("source_kind", source_kind))
}

pub fn save_extraction_state<H: Host + ?Sized>(host: &H, source_kind: &str, extracted_at: &str) -> Result<()> {
    let at = now(host)?;
    let client = Client(host);
    if let Some(row) = extraction_state(host, source_kind)? {
        let id = row["id"].as_str().ok_or_else(|| Error::new("Invalid state row"))?;
        client.query(
            STATE,
            &Query::update(
                Filter::eq("id", id),
                values(vec![("last_extracted_at", json!(extracted_at)), ("last_run_at", json!(at)), ("updated_at", json!(at))]),
            ),
        )?;
    } else {
        client.query(
            STATE,
            &Query::insert(values(vec![
                ("source_kind", json!(source_kind)),
                ("last_extracted_at", json!(extracted_at)),
                ("last_run_at", json!(at)),
            ])),
        )?;
    }
    Ok(())
}

/// What the last judgement of each named thread concluded, newest message read and outcome.
pub fn thread_judgement<H: Host + ?Sized>(host: &H, thread_ref: &str) -> Result<Option<Value>> {
    one(host, JUDGEMENTS, Filter::eq("thread_ref", thread_ref))
}

pub fn record_thread_judgement<H: Host + ?Sized>(
    host: &H,
    thread_ref: &str,
    external_id: &str,
    outcome: &str,
) -> Result<()> {
    let at = now(host)?;
    let client = Client(host);
    let changes = vec![
        ("last_judged_external_id", json!(external_id)),
        ("outcome", json!(outcome)),
        ("judged_at", json!(at)),
    ];
    if thread_judgement(host, thread_ref)?.is_some() {
        client.query(JUDGEMENTS, &Query::update(Filter::eq("thread_ref", thread_ref), values(changes)))?;
    } else {
        let mut fields = changes;
        fields.push(("thread_ref", json!(thread_ref)));
        client.query(JUDGEMENTS, &Query::insert(values(fields)))?;
    }
    Ok(())
}

pub fn judgements_for<H: Host + ?Sized>(host: &H, refs: &[String]) -> Result<Vec<Value>> {
    if refs.is_empty() {
        return Ok(vec![]);
    }
    let mut query = Query::select(Filter::In { column: "thread_ref".into(), values: refs.iter().map(|r| json!(r)).collect() });
    query.order = vec![Order { column: "judged_at".into(), descending: true }];
    Client(host).query(JUDGEMENTS, &query)
}
