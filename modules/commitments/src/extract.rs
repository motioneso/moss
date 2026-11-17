//! Finds commitments in text a source module hands over. The model proposes candidates and
//! nothing more. A proposal waits in `pending_review` until the person confirms it.
use crate::{prefilter, signature, store};
use chrono::{DateTime, SecondsFormat, Utc};
use moss_module_sdk::{Client, Error, Host, Result};
use serde_json::{json, Value};

const MAX_TEXT_CHARS: usize = 4000;
const MAX_OUTPUT_TOKENS: u32 = 1024;
const KINDS: [&str; 4] = ["deadline", "promise", "obligation", "intent"];
const CONFIDENCE: [&str; 3] = ["high", "medium", "low"];
pub const SOURCE_KINDS: [&str; 3] = ["chat", "email", "notes"];

const SYSTEM_PROMPT: &str = "You are a commitment extraction assistant. Given a text excerpt, identify all explicit commitments, deadlines, promises, and obligations. Return a JSON object with a \"candidates\" array. Each candidate:\n- kind: \"deadline\" | \"promise\" | \"obligation\" | \"intent\"\n- title: <=100 chars\n- dueLocalDate: ISO date YYYY-MM-DD if detected, else null\n- counterpartyLabel: person/entity committed to (<=100 chars), else null\n- evidenceExcerpt: verbatim supporting text (<=500 chars)\n- confidence: \"high\" | \"medium\" | \"low\"\nReturn ONLY valid JSON. Return {\"candidates\":[]} if no commitments found.";

/// A closed set of events. A warning names what happened and the source kind, never text.
#[derive(Debug, PartialEq)]
pub struct Warning {
    pub event: &'static str,
    pub source_kind: String,
}

impl Warning {
    pub fn to_json(&self) -> Value {
        json!({"event": self.event, "sourceKind": self.source_kind})
    }
}

#[derive(Debug, PartialEq)]
pub struct Extracted {
    pub kind: String,
    pub title: String,
    pub due_local_date: Option<String>,
    pub counterparty_label: Option<String>,
    pub evidence_excerpt: String,
    pub confidence: String,
}

fn valid(candidate: &Value) -> Option<Extracted> {
    let obj = candidate.as_object()?;
    let kind = obj.get("kind")?.as_str().filter(|k| KINDS.contains(k))?;
    let title = obj.get("title")?.as_str()?;
    let optional = |key: &str| match obj.get(key) {
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        _ => None,
    };
    let due = optional("dueLocalDate")?;
    let counterparty = optional("counterpartyLabel")?;
    let excerpt = obj.get("evidenceExcerpt")?.as_str()?;
    let confidence = obj.get("confidence")?.as_str().filter(|c| CONFIDENCE.contains(c))?;
    Some(Extracted {
        kind: kind.to_owned(),
        title: title.chars().take(100).collect(),
        due_local_date: due.filter(|d| !d.is_empty()),
        counterparty_label: counterparty.filter(|c| !c.is_empty()).map(|c| c.chars().take(100).collect()),
        evidence_excerpt: excerpt.chars().take(500).collect(),
        confidence: confidence.to_owned(),
    })
}

/// Reads the model's answer. Anything that is not an object with a candidates list is malformed.
fn parse_answer(answer: &str) -> Option<Vec<Extracted>> {
    let (start, end) = (answer.find('{')?, answer.rfind('}')?);
    let parsed: Value = serde_json::from_str(answer.get(start..=end)?).ok()?;
    Some(parsed.get("candidates")?.as_array()?.iter().filter_map(valid).collect())
}

/// Candidates found in one piece of text. Email text is never extracted here, because it lacks
/// proof the owner took part, so the thread judgement handles it. A failed model call or an
/// unreadable answer finds nothing and leaves a warning.
pub fn from_text<H: Host + ?Sized>(
    host: &H,
    text: &str,
    source_kind: &str,
    occurred_at: &str,
    warnings: &mut Vec<Warning>,
) -> Vec<Extracted> {
    if source_kind == "email" || !prefilter::passes(text) {
        return vec![];
    }
    let excerpt: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let prompt = format!("{SYSTEM_PROMPT}\n\nSource: {source_kind} at {occurred_at}\n\nText:\n{excerpt}");
    let warn = |event| Warning { event, source_kind: source_kind.to_owned() };
    let answer = match host.call("ai", "generate", "summarization", json!({"prompt": prompt, "maxOutputTokens": MAX_OUTPUT_TOKENS})) {
        Ok(answer) => answer,
        Err(_) => {
            warnings.push(warn("commitment-extraction-adapter-error"));
            return vec![];
        }
    };
    match answer["text"].as_str().and_then(parse_answer) {
        Some(found) => found,
        None => {
            warnings.push(warn("commitment-extraction-malformed-output"));
            vec![]
        }
    }
}

struct Boundary {
    text: String,
    occurred_at: String,
    source_ref: String,
    source_version: i64,
}

/// The module that supplies text for a source. Email has none, because the thread judgement
/// reads email, and no module supplies chat text yet.
fn provider(source_kind: &str) -> Option<&'static str> {
    (source_kind == "notes").then_some("notes")
}

fn boundaries<H: Host + ?Sized>(host: &H, module: &str, since: Option<&str>) -> Option<Vec<Boundary>> {
    let answer = Client(host).api(module, "listCommitmentText", json!({"since": since})).ok()?;
    answer["boundaries"]
        .as_array()?
        .iter()
        .map(|b| {
            Some(Boundary {
                text: b["text"].as_str()?.to_owned(),
                occurred_at: b["occurredAt"].as_str()?.to_owned(),
                source_ref: b["sourceRef"].as_str()?.to_owned(),
                source_version: b["sourceVersion"].as_i64().unwrap_or(0),
            })
        })
        .collect()
}

/// One extraction run for one source. The job carries only the source kind. The text comes
/// from the source module while the job runs and goes only to the model and the candidate tables.
pub fn run<H: Host + ?Sized>(host: &H, source_kind: &str) -> Result<Vec<Warning>> {
    if !SOURCE_KINDS.contains(&source_kind) {
        return Err(Error::new("Unknown commitment source"));
    }
    let mut warnings = vec![];
    let missing = || Warning { event: "commitment-extraction-source-provider-missing", source_kind: source_kind.to_owned() };
    let Some(module) = provider(source_kind) else { return Ok(vec![missing()]) };
    let since = store::extraction_state(host, source_kind)?
        .and_then(|row| row["last_extracted_at"].as_str().map(str::to_owned));
    let started = store::now(host)?;
    let Some(found) = boundaries(host, module, since.as_deref()) else { return Ok(vec![missing()]) };
    for boundary in found {
        for item in from_text(host, &boundary.text, source_kind, &boundary.occurred_at, &mut warnings) {
            let sig = signature::candidate_signature(&signature::SignatureInput {
                kind: &item.kind,
                counterparty_label: item.counterparty_label.as_deref(),
                title: &item.title,
                due_local_date: item.due_local_date.as_deref(),
                source_kind,
                source_ref: &boundary.source_ref,
            });
            let row = store::upsert_candidate(host, &store::Candidate {
                signature: &sig,
                kind: &item.kind,
                title: &item.title,
                due_local_date: item.due_local_date.as_deref(),
                counterparty_label: item.counterparty_label.as_deref(),
                confidence: &item.confidence,
                suggested_handling: None,
                email: None,
            })?;
            let id = row["id"].as_str().ok_or_else(|| Error::new("Invalid candidate row"))?;
            let at = DateTime::parse_from_rfc3339(&boundary.occurred_at)
                .ok()
                .map(|t| t.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true));
            store::add_evidence(host, id, source_kind, &boundary.source_ref, boundary.source_version, &item.evidence_excerpt, at.as_deref())?;
        }
    }
    store::save_extraction_state(host, source_kind, &started)?;
    Ok(warnings)
}
