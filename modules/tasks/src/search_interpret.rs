//! Natural-language task search. The host picks the AI model; the guest only
//! builds the prompt and validates the answer against the account's own lists and tags.
use crate::{
    parse,
    repository::{Error, Repository, Result},
};
use moss_module_sdk::Host;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

const STATUSES: &[&str] = &["todo", "suggested", "done", "archived"];
const EFFORTS: &[&str] = &["quick", "medium", "large"];
const QUADRANTS: &[&str] = &["do", "schedule", "delegate", "eliminate"];

fn unavailable() -> Error {
    Error::Http(503, "Natural-language task search is unavailable")
}

fn query(body: &Value) -> Result<String> {
    let object = body
        .as_object()
        .ok_or(Error::Http(400, "request body must be an object"))?;
    let raw = object
        .get("query")
        .and_then(Value::as_str)
        .ok_or(Error::Http(400, "query must be a string"))?;
    // Ajv counts code points and bounds the untrimmed length before the handler trims.
    match raw.chars().count() {
        0 => return Err(Error::Http(400, "body/query must NOT have fewer than 1 characters")),
        n if n > 300 => {
            return Err(Error::Http(400, "body/query must NOT have more than 300 characters"))
        }
        _ => (),
    }
    let trimmed = parse::js_trim(raw);
    if trimmed.is_empty() || trimmed.encode_utf16().count() > 300 {
        return Err(Error::Http(400, "query must be 1-300 characters"));
    }
    Ok(trimmed.to_owned())
}

const MAX_LISTS: usize = 200;
const MAX_TAGS: usize = 300;

pub fn interpret<H: Host + ?Sized>(
    repo: &Repository<'_, H>,
    host: &H,
    body: &Value,
) -> Result<Value> {
    let query = query(body)?;
    let lists = repo.lists()?;
    let mut tag_names = BTreeSet::new();
    for list in &lists {
        for tag in repo.tags(&list.id)? {
            tag_names.insert(tag.name);
        }
    }
    // The host refuses prompts over 64 KB, so the vocabulary is capped.
    let list_vocabulary: Vec<Value> = lists
        .iter()
        .take(MAX_LISTS)
        .map(|l| json!({"id":l.id,"name":l.name}))
        .collect();
    let tag_vocabulary: Vec<&String> = tag_names.iter().take(MAX_TAGS).collect();
    let today = repo.now()?.get(..10).unwrap_or_default().to_owned();
    let prompt = [
        "Convert the user's task search phrase into JSON only.".to_owned(),
        r#"Allowed shape: {"text":string|null,"status":"todo|done|archived"|null,"effort":"quick|medium|large"|null,"priority":1-5|null,"listIds":string[],"tagNames":string[],"quadrant":"do|schedule|delegate|eliminate"|null,"due":{"kind":"none|overdue|today|this_week"}|{"kind":"range","dueAfter":string|null,"dueBefore":string|null}|null}."#.to_owned(),
        "Known lists:".to_owned(),
        Value::Array(list_vocabulary).to_string(),
        "Known tags:".to_owned(),
        serde_json::to_string(&tag_vocabulary)?,
        format!("Today in the user's locale: {today}."),
        format!("User phrase: {}", Value::String(query)),
        "Return JSON only. Do not invent task data.".to_owned(),
    ]
    .join("\n");
    let reply = host
        .call(
            "ai",
            "generate",
            "chat",
            json!({"prompt":prompt,"maxOutputTokens":500}),
        )
        .map_err(|_| unavailable())?;
    let text = reply["text"].as_str().ok_or_else(unavailable)?;
    let raw: Value = serde_json::from_str(text)
        .map_err(|_| Error::Http(502, "Task search interpreter returned invalid JSON"))?;
    let known_lists: BTreeSet<&str> = lists.iter().map(|l| l.id.as_str()).collect();
    normalize(&raw, &known_lists, &tag_names)
}

fn enum_value(value: Option<&Value>, allowed: &[&str]) -> Value {
    match value.and_then(Value::as_str) {
        Some(text) if allowed.contains(&text) => json!(text),
        _ => Value::Null,
    }
}

fn day_key(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_str) {
        Some(text)
            if text.len() == 10
                && text.bytes().enumerate().all(|(i, b)| match i {
                    4 | 7 => b == b'-',
                    _ => b.is_ascii_digit(),
                }) =>
        {
            json!(text)
        }
        _ => Value::Null,
    }
}

fn normalize(
    raw: &Value,
    known_lists: &BTreeSet<&str>,
    tag_names: &BTreeSet<String>,
) -> Result<Value> {
    let raw = raw
        .as_object()
        .ok_or(Error::Http(502, "Task search interpreter returned invalid JSON"))?;
    let mut warnings: Vec<String> = vec![];
    let mut list_ids: Vec<String> = vec![];
    for item in raw
        .get("listIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = item.as_str() else { continue };
        if known_lists.contains(id) {
            if !list_ids.iter().any(|existing| existing == id) {
                list_ids.push(id.to_owned());
            }
        } else {
            warnings.push(format!("Unknown list ignored: {id}"));
        }
    }
    let mut tags: Vec<String> = vec![];
    for item in raw
        .get("tagNames")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = item.as_str() else { continue };
        let lower = name.to_lowercase();
        match tag_names.iter().find(|t| t.to_lowercase() == lower) {
            Some(tag) => {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            None => warnings.push(format!("Unknown tag ignored: {name}")),
        }
    }
    let text = match raw.get("text").and_then(Value::as_str) {
        Some(t) if !parse::js_trim(t).is_empty() => json!(parse::js_trim(t)),
        _ => Value::Null,
    };
    let priority = match raw.get("priority") {
        Some(Value::Number(n)) => match n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.fract() == 0.0)
                .map(|f| f as i64)
        }) {
            Some(p) if (1..=5).contains(&p) => json!(p),
            _ => Value::Null,
        },
        _ => Value::Null,
    };
    let due = match raw.get("due").and_then(Value::as_object) {
        Some(due) => match due.get("kind").and_then(Value::as_str) {
            Some(kind @ ("none" | "overdue" | "today" | "this_week")) => json!({"kind":kind}),
            Some("range") => json!({
                "kind":"range",
                "dueAfter":day_key(due.get("dueAfter")),
                "dueBefore":day_key(due.get("dueBefore")),
            }),
            _ => Value::Null,
        },
        None => Value::Null,
    };
    let confidence = match raw.get("confidence").and_then(Value::as_str) {
        Some(c @ ("high" | "medium" | "low")) => c,
        _ => "medium",
    };
    let mut intent = Map::new();
    intent.insert("text".into(), text);
    intent.insert("status".into(), enum_value(raw.get("status"), STATUSES));
    intent.insert("effort".into(), enum_value(raw.get("effort"), EFFORTS));
    intent.insert("priority".into(), priority);
    intent.insert("listIds".into(), json!(list_ids));
    intent.insert("tagNames".into(), json!(tags));
    intent.insert("quadrant".into(), enum_value(raw.get("quadrant"), QUADRANTS));
    intent.insert("due".into(), due);
    Ok(json!({"intent":intent,"confidence":confidence,"warnings":warnings}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocabulary() -> (BTreeSet<&'static str>, BTreeSet<String>) {
        (
            ["list-1"].into_iter().collect(),
            ["Home".to_owned(), "Work".to_owned()].into_iter().collect(),
        )
    }

    #[test]
    fn query_must_be_trimmed_and_bounded() {
        assert!(query(&json!([])).is_err());
        assert!(query(&json!({"query":""})).is_err());
        assert!(query(&json!({"query":"   "})).is_err());
        assert!(query(&json!({"query":"x".repeat(301)})).is_err());
        assert_eq!(query(&json!({"query":"  due today "})).unwrap(), "due today");
        // 200 astral characters pass the schema (code points) but not the trimmed check (UTF-16).
        let error = query(&json!({"query":"\u{1F600}".repeat(200)})).unwrap_err();
        assert!(format!("{error:?}").contains("1-300"));
    }

    #[test]
    fn answer_is_limited_to_known_lists_and_tags() {
        let (lists, tags) = vocabulary();
        let raw = json!({
            "text":"  report ","status":"done","effort":"huge","priority":3,
            "listIds":["list-1","other","list-1"],"tagNames":["work","Missing","WORK"],
            "quadrant":"do","due":{"kind":"range","dueAfter":"2026-01-02","dueBefore":"bad"},
            "confidence":"high"
        });
        let out = normalize(&raw, &lists, &tags).unwrap();
        assert_eq!(
            out,
            json!({"intent":{"text":"report","status":"done","effort":null,"priority":3,
                "listIds":["list-1"],"tagNames":["Work"],"quadrant":"do",
                "due":{"kind":"range","dueAfter":"2026-01-02","dueBefore":null}},
                "confidence":"high",
                "warnings":["Unknown list ignored: other","Unknown tag ignored: Missing"]})
        );
    }

    #[test]
    fn invalid_values_fall_back_to_empty() {
        let (lists, tags) = vocabulary();
        let out = normalize(&json!({"priority":9,"due":{"kind":"later"}}), &lists, &tags).unwrap();
        assert_eq!(out["intent"]["priority"], Value::Null);
        assert_eq!(out["intent"]["due"], Value::Null);
        assert_eq!(out["confidence"], "medium");
        assert!(normalize(&json!("text"), &lists, &tags).is_err());
    }
}
