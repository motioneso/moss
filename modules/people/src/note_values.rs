//! Compatibility for note-only PATCH members, which legacy Fastify leaves unvalidated.
//! Keep JS array interpolation distinct from join: null renders as "null" in
//! frontmatter, but as an empty item in a managed email/phone summary.
use crate::notes_format::{format_people_note, parse_people_note, replace_moss_managed_section};
use moss_module_sdk::{Error, Result};
use serde_json::{json, Value};

pub fn update(content: &str, id: &str, patch: &Value) -> Result<String> {
    let mut note = parse_people_note(content)
        .filter(|note| note.frontmatter.jarvis_person_id.as_deref() == Some(id))
        .ok_or_else(|| Error::new("Canonical People note not found"))?;
    let fm = &mut note.frontmatter;
    if let Some(name) = patch.get("displayName").and_then(Value::as_str) {
        fm.display_name = name.into();
    }
    if let Some(status) = patch.get("status").filter(|v| !v.is_null()) {
        fm.status = serde_json::from_value(status.clone())?;
    }
    let mut summary = vec![format!("Display name: {}", fm.display_name)];
    for (key, label, values) in [
        ("aliases", None, &mut fm.aliases),
        ("emails", Some("Emails"), &mut fm.emails),
        ("phones", Some("Phones"), &mut fm.phones),
    ] {
        let items = match patch.get(key).filter(|v| !v.is_null()) {
            None => values.iter().map(|v| json!(v)).collect(),
            Some(value) => elements(value)?,
        };
        if let Some(label) = label {
            if !items.is_empty() {
                summary.push(format!("{label}: {}", join(&items, ", ")?));
            }
        }
        *values = items.iter().map(text).collect::<Result<_>>()?;
    }
    note.body = replace_moss_managed_section(&note.body, &summary.join("\n"));
    Ok(format_people_note(&note))
}

fn elements(value: &Value) -> Result<Vec<Value>> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(s) if s.is_empty() => Ok(vec![]),
        Value::Object(object) if object.get("length").and_then(Value::as_f64) == Some(0.0) => {
            Ok(vec![])
        }
        _ => Err(Error::new("Invalid People note array")),
    }
}
fn join(items: &[Value], separator: &str) -> Result<String> {
    items
        .iter()
        .map(|item| {
            if item.is_null() {
                Ok(String::new())
            } else {
                text(item)
            }
        })
        .collect::<Result<Vec<_>>>()
        .map(|parts| parts.join(separator))
}
fn text(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Null => Ok("null".into()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Number(n) => Ok(crate::route_validation::number_text(n)),
        Value::Array(items) => join(items, ","),
        // Ordinary JSON objects stringify through Object.prototype.toString.
        // An own non-callable toString shadows it and makes JS conversion fail.
        Value::Object(object) if !object.contains_key("toString") => Ok("[object Object]".into()),
        _ => Err(Error::new("Invalid People note value")),
    }
}
