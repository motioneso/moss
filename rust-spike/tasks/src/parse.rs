//! The handler-side body rules from `packages/tasks/src/routes.ts`, after schema checks.
//! Each function keeps the TypeScript message text, because clients and tests match on it.

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Map, Value};

use crate::dates::parse_js_date;
use safety_core::error::ApiError;
use crate::model::{Recurrence, TaskStatus};

/// A field the request may set, clear, or leave alone.
#[derive(Clone, Debug, PartialEq)]
pub enum Patch<T> {
    Keep,
    Clear,
    Set(T),
}

impl<T> Patch<T> {
    pub fn is_keep(&self) -> bool {
        matches!(self, Patch::Keep)
    }
}

#[derive(Debug)]
pub struct TaskFields {
    pub title: Option<String>,
    pub description: Patch<String>,
    pub status: Option<TaskStatus>,
    pub priority: Patch<i16>,
    pub due_at: Patch<DateTime<Utc>>,
    pub list_id: Option<String>,
    pub do_at: Patch<DateTime<Utc>>,
    pub effort: Patch<String>,
    pub parent_task_id: Patch<String>,
    pub recurrence: Patch<Recurrence>,
}

pub fn require_object(value: &Value) -> Result<&Map<String, Value>, ApiError> {
    value.as_object().ok_or_else(|| ApiError::http(400, "Expected JSON object body"))
}

pub fn parse_create_task(body: &Value) -> Result<TaskFields, ApiError> {
    let value = require_object(body)?;
    Ok(TaskFields {
        title: Some(required_string(value.get("title"), "title")?),
        description: optional_nullable_string(value.get("description"), "description")?,
        status: Some(optional_task_status(value.get("status"))?.unwrap_or(TaskStatus::Todo)),
        priority: optional_priority(value.get("priority"))?,
        due_at: optional_date(value.get("dueAt"), "dueAt")?,
        list_id: optional_string(value.get("listId"), "listId")?,
        do_at: optional_date(value.get("doAt"), "doAt")?,
        effort: optional_effort(value.get("effort"))?,
        parent_task_id: optional_nullable_string(value.get("parentTaskId"), "parentTaskId")?,
        recurrence: optional_recurrence(value.get("recurrence"))?,
    })
}

pub fn parse_update_task(body: &Value) -> Result<TaskFields, ApiError> {
    let value = require_object(body)?;
    Ok(TaskFields {
        title: optional_string(value.get("title"), "title")?,
        description: optional_nullable_string(value.get("description"), "description")?,
        status: optional_task_status(value.get("status"))?,
        priority: optional_priority(value.get("priority"))?,
        due_at: optional_date(value.get("dueAt"), "dueAt")?,
        list_id: optional_string(value.get("listId"), "listId")?,
        do_at: optional_date(value.get("doAt"), "doAt")?,
        effort: optional_effort(value.get("effort"))?,
        parent_task_id: optional_nullable_string(value.get("parentTaskId"), "parentTaskId")?,
        recurrence: optional_recurrence(value.get("recurrence"))?,
    })
}

pub struct ActivityInput {
    pub activity_type: String,
    pub body: Option<String>,
}

pub fn parse_activity(body: &Value) -> Result<ActivityInput, ApiError> {
    let value = require_object(body)?;
    Ok(ActivityInput {
        activity_type: optional_string(value.get("activityType"), "activityType")?
            .unwrap_or_else(|| "comment".to_owned()),
        body: match optional_nullable_string(value.get("body"), "body")? {
            Patch::Set(text) => Some(text),
            Patch::Clear | Patch::Keep => None,
        },
    })
}

pub struct DeferredStatusInput {
    pub status: TaskStatus,
    pub idempotency_key: Option<String>,
}

pub fn parse_deferred_status(body: &Value) -> Result<DeferredStatusInput, ApiError> {
    let value = require_object(body)?;
    let status = optional_task_status(value.get("status"))?
        .ok_or_else(|| ApiError::http(400, "status is required"))?;
    Ok(DeferredStatusInput {
        status,
        idempotency_key: optional_string(value.get("idempotencyKey"), "idempotencyKey")?,
    })
}

pub fn required_string(value: Option<&Value>, field: &str) -> Result<String, ApiError> {
    optional_string(value, field)?.ok_or_else(|| ApiError::http(400, format!("{field} is required")))
}

pub fn optional_string(value: Option<&Value>, field: &str) -> Result<Option<String>, ApiError> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            if trimmed.is_empty() {
                Err(ApiError::http(400, format!("{field} must not be empty")))
            } else {
                Ok(Some(trimmed.to_owned()))
            }
        }
        Some(_) => Err(ApiError::http(400, format!("{field} must be a string"))),
    }
}

fn optional_nullable_string(value: Option<&Value>, field: &str) -> Result<Patch<String>, ApiError> {
    match value {
        Some(Value::Null) => Ok(Patch::Clear),
        Some(Value::String(text)) if text.is_empty() => Ok(Patch::Clear),
        other => Ok(optional_string(other, field)?.map_or(Patch::Keep, Patch::Set)),
    }
}

fn optional_effort(value: Option<&Value>) -> Result<Patch<String>, ApiError> {
    match value {
        None => Ok(Patch::Keep),
        Some(Value::Null) => Ok(Patch::Clear),
        Some(Value::String(text)) if text.is_empty() => Ok(Patch::Clear),
        Some(Value::String(text)) if ["quick", "medium", "large"].contains(&text.as_str()) => {
            Ok(Patch::Set(text.clone()))
        }
        Some(_) => Err(ApiError::http(400, "effort must be quick, medium, or large")),
    }
}

fn optional_recurrence(value: Option<&Value>) -> Result<Patch<Recurrence>, ApiError> {
    match value {
        None => Ok(Patch::Keep),
        Some(Value::Null) => Ok(Patch::Clear),
        Some(Value::String(text)) if text.is_empty() => Ok(Patch::Clear),
        Some(object @ Value::Object(_)) => parse_recurrence(object).map(Patch::Set).ok_or_else(|| {
            ApiError::http(
                400,
                "recurrence must include freq daily, weekly, or monthly; positive integer interval; and YYYY-MM-DD occurrence_date",
            )
        }),
        Some(_) => Err(ApiError::http(400, "recurrence must be an object")),
    }
}

/// `parseRecurrenceSpec` from `recurrence.ts`; `None` where TypeScript returns null.
pub fn parse_recurrence(value: &Value) -> Option<Recurrence> {
    let record = value.as_object()?;
    let freq = record.get("freq")?.as_str()?;
    if !["daily", "weekly", "monthly"].contains(&freq) {
        return None;
    }
    let interval = record.get("interval")?.as_f64()?;
    if interval.fract() != 0.0 || interval < 1.0 {
        return None;
    }
    let occurrence_date = record.get("occurrence_date")?.as_str()?;
    if !is_valid_occurrence_date(occurrence_date) {
        return None;
    }
    Some(Recurrence {
        freq: freq.to_owned(),
        interval: interval as i64,
        occurrence_date: occurrence_date.to_owned(),
    })
}

fn is_valid_occurrence_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        && NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
}

fn optional_task_status(value: Option<&Value>) -> Result<Option<TaskStatus>, ApiError> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) => match text.as_str() {
            "todo" => Ok(Some(TaskStatus::Todo)),
            "done" => Ok(Some(TaskStatus::Done)),
            "archived" => Ok(Some(TaskStatus::Archived)),
            _ => Err(ApiError::http(400, "status is invalid")),
        },
        Some(_) => Err(ApiError::http(400, "status is invalid")),
    }
}

fn optional_priority(value: Option<&Value>) -> Result<Patch<i16>, ApiError> {
    match value {
        None => Ok(Patch::Keep),
        Some(Value::Null) => Ok(Patch::Clear),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(n) if n.fract() == 0.0 && (1.0..=5.0).contains(&n) => Ok(Patch::Set(n as i16)),
            _ => Err(ApiError::http(400, "priority must be an integer from 1 to 5")),
        },
        Some(_) => Err(ApiError::http(400, "priority must be an integer from 1 to 5")),
    }
}

fn optional_date(value: Option<&Value>, field: &str) -> Result<Patch<DateTime<Utc>>, ApiError> {
    match value {
        None => Ok(Patch::Keep),
        Some(Value::Null) => Ok(Patch::Clear),
        Some(Value::String(text)) if text.is_empty() => Ok(Patch::Clear),
        Some(Value::String(text)) => parse_js_date(text)
            .map(Patch::Set)
            .ok_or_else(|| ApiError::http(400, format!("{field} must be an ISO timestamp"))),
        Some(_) => Err(ApiError::http(400, format!("{field} must be an ISO timestamp"))),
    }
}

/// `String.prototype.trim`, which also strips the Unicode spaces and line terminators.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
