//! Request body checks that give the answers the old route schema gave. The old server coerced
//! numbers and booleans to text, dropped unknown fields and reported the first failure.
use serde_json::{Map, Value};

fn js_number(number: &serde_json::Number) -> String {
    match number.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() < 1e21 && !number.is_u64() && !number.is_i64() => {
            format!("{}", f as i64)
        }
        _ => number.to_string(),
    }
}

fn object(body: &Value) -> Result<&Map<String, Value>, String> {
    body.as_object().ok_or_else(|| "body must be object".to_owned())
}

fn required(map: &Map<String, Value>, names: &[&str]) -> Result<(), String> {
    for name in names {
        if !map.contains_key(*name) {
            return Err(format!("body must have required property '{name}'"));
        }
    }
    Ok(())
}

fn text(map: &Map<String, Value>, name: &str, min: usize) -> Result<Option<String>, String> {
    let at = format!("body/{name}");
    let value = match map.get(name) {
        None => return Ok(None),
        Some(Value::Null) => String::new(),
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => js_number(n),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => return Err(format!("{at} must be string")),
    };
    if value.chars().count() < min {
        return Err(format!("{at} must NOT have fewer than {min} characters"));
    }
    Ok(Some(value))
}

/// A field that may be sent as null to clear it. Absent stays absent.
pub fn clearable(map: &Map<String, Value>, name: &str) -> Result<Option<Option<String>>, String> {
    match map.get(name) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(_) => Ok(Some(text(map, name, 0)?)),
    }
}

/// The old schema's union answer, word for word.
fn union_error(name: &str, count: usize) -> String {
    let one = format!("body/{name} must be equal to constant");
    format!("{}, body/{name} must match a schema in anyOf", vec![one; count].join(", "))
}

fn priority(map: &Map<String, Value>) -> Result<Option<i64>, String> {
    match map.get("priority") {
        None => Ok(None),
        Some(Value::Number(n)) if n.as_i64().is_some_and(|v| (1..=5).contains(&v)) => Ok(n.as_i64()),
        Some(_) => Err(union_error("priority", 5)),
    }
}

fn cadence(map: &Map<String, Value>) -> Result<Option<String>, String> {
    let value = text(map, "reviewCadence", 0)?;
    match &value {
        None => Ok(None),
        Some(v) if ["none", "daily", "weekly", "biweekly", "monthly", "custom"].contains(&v.as_str()) => Ok(value),
        Some(_) => Err(union_error("reviewCadence", 6)),
    }
}

fn datetime(map: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    let value = text(map, name, 0)?;
    match &value {
        None => Ok(None),
        Some(v) if chrono::DateTime::parse_from_rfc3339(v).is_ok() => Ok(value),
        Some(_) => Err(format!("body/{name} must match format \"date-time\"")),
    }
}

pub struct NewGoal {
    pub title: String,
    pub desired_outcome: String,
    pub priority: Option<i64>,
    pub review_cadence: Option<String>,
    pub target_at: Option<String>,
}

pub fn new_goal(body: &Value) -> Result<NewGoal, String> {
    let map = object(body)?;
    required(map, &["title", "desiredOutcome"])?;
    Ok(NewGoal {
        title: text(map, "title", 1)?.unwrap_or_default(),
        desired_outcome: text(map, "desiredOutcome", 1)?.unwrap_or_default(),
        priority: priority(map)?,
        review_cadence: cadence(map)?,
        target_at: datetime(map, "targetAt")?,
    })
}

#[derive(Default)]
pub struct GoalChange {
    pub title: Option<String>,
    pub desired_outcome: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub review_cadence: Option<String>,
    pub target_at: Option<Option<String>>,
    pub last_progress_summary: Option<Option<String>>,
    pub blocker_summary: Option<Option<String>>,
    pub next_suggested_action: Option<Option<String>>,
}

pub fn goal_change(body: &Value) -> Result<GoalChange, String> {
    let map = object(body)?;
    let status = text(map, "status", 0)?;
    if let Some(v) = &status {
        if !["active", "paused", "blocked", "completed", "archived"].contains(&v.as_str()) {
            return Err(union_error("status", 5));
        }
    }
    Ok(GoalChange {
        title: text(map, "title", 1)?,
        desired_outcome: text(map, "desiredOutcome", 1)?,
        status,
        priority: priority(map)?,
        review_cadence: cadence(map)?,
        target_at: match map.get("targetAt") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(_) => Some(datetime(map, "targetAt")?),
        },
        last_progress_summary: clearable(map, "lastProgressSummary")?,
        blocker_summary: clearable(map, "blockerSummary")?,
        next_suggested_action: clearable(map, "nextSuggestedAction")?,
    })
}

pub struct NewEvidence {
    pub evidence_kind: String,
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub source_label: String,
    pub summary: String,
    pub occurred_at: Option<String>,
}

pub fn new_evidence(body: &Value) -> Result<NewEvidence, String> {
    let map = object(body)?;
    required(map, &["evidenceKind", "sourceKind", "sourceLabel", "summary"])?;
    let kind = text(map, "evidenceKind", 0)?.unwrap_or_default();
    if !["context", "task", "status", "progress", "blocker", "decision", "checkpoint", "suggested_action"]
        .contains(&kind.as_str())
    {
        return Err(union_error("evidenceKind", 8));
    }
    let source = text(map, "sourceKind", 0)?.unwrap_or_default();
    if !["goal", "task", "note", "email", "calendar", "chat", "memory", "manual"].contains(&source.as_str()) {
        return Err(union_error("sourceKind", 8));
    }
    Ok(NewEvidence {
        evidence_kind: kind,
        source_kind: source,
        source_ref: text(map, "sourceRef", 0)?,
        source_label: text(map, "sourceLabel", 0)?.unwrap_or_default(),
        summary: text(map, "summary", 0)?.unwrap_or_default(),
        occurred_at: datetime(map, "occurredAt")?,
    })
}
