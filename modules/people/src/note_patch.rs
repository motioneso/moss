//! Legacy PATCH leaves contact arrays outside its HTTP schema. Preserve the
//! JavaScript rendering of those values without widening the typed note API.
use crate::{
    note_edits::{self, UpdateNote},
    notes_format::parse_people_note,
};
use moss_module_sdk::{Error, Result};
use serde_json::Value;

// Array.join treats null as empty, whereas template interpolation renders null.
// Nested arrays use join for their own elements in either context.
fn text(value: &Value, joining: bool) -> Result<String> {
    Ok(match value {
        Value::Null => if joining { "" } else { "null" }.into(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => crate::route_validation::number_text(value),
        Value::Array(values) => values
            .iter()
            .map(|value| text(value, true))
            .collect::<Result<Vec<_>>>()?
            .join(","),
        // A JSON member cannot be callable. Shadowing Object.toString leaves
        // no primitive conversion, just as it does in the legacy formatter.
        Value::Object(value) if value.contains_key("toString") => {
            return Err(Error::new("Invalid People note value"));
        }
        Value::Object(_) => "[object Object]".into(),
    })
}

pub(crate) fn update(current: Option<&str>, id: &str, value: &Value) -> Result<String> {
    let note = current
        .and_then(parse_people_note)
        .filter(|note| note.frontmatter.jarvis_person_id.as_deref() == Some(id))
        .ok_or_else(|| Error::new(note_edits::EditError::CanonicalNoteNotFound.to_string()))?;
    let mut fields = serde_json::Map::new();
    for name in ["displayName", "status"] {
        if let Some(value) = value.get(name) {
            fields.insert(name.into(), value.clone());
        }
    }
    let mut joins = Vec::new();
    for (name, fallback) in [
        ("aliases", &note.frontmatter.aliases),
        ("emails", &note.frontmatter.emails),
        ("phones", &note.frontmatter.phones),
    ] {
        let (rendered, joined) = match value.get(name).filter(|v| !v.is_null()) {
            None => (fallback.clone(), fallback.join(", ")),
            Some(Value::String(s)) if s.is_empty() => (Vec::new(), String::new()),
            Some(Value::Object(v)) if v.get("length").and_then(Value::as_f64) == Some(0.0) => {
                (Vec::new(), String::new())
            }
            Some(Value::Array(values)) => (
                values
                    .iter()
                    .map(|v| text(v, false))
                    .collect::<Result<Vec<_>>>()?,
                values
                    .iter()
                    .map(|v| text(v, true))
                    .collect::<Result<Vec<_>>>()?
                    .join(", "),
            ),
            _ => return Err(Error::new("Invalid People note array")),
        };
        joins.push((!rendered.is_empty(), joined));
        fields.insert(name.into(), serde_json::to_value(rendered)?);
    }
    let patch: UpdateNote = serde_json::from_value(Value::Object(fields))?;
    let mut summary = vec![format!(
        "Display name: {}",
        patch
            .display_name
            .as_deref()
            .unwrap_or(&note.frontmatter.display_name)
    )];
    for (label, (has_values, joined)) in ["Emails", "Phones"].into_iter().zip(&joins[1..]) {
        if *has_values {
            summary.push(format!("{label}: {joined}"));
        }
    }
    note_edits::update_note_with_summary(current, id, &patch, Some(&summary.join("\n")))
        .map_err(|error| Error::new(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::update;
    use crate::{
        note_edits::{create_note, CreateNote},
        notes_format::{parse_people_note, NoteStatus},
    };
    use serde_json::json;

    const NOTE: &str = "---\njarvisPersonId: person\ndisplayName: Alice\naliases:\n  - Al\nemails:\n  - old@example.test\nphones: []\nstatus: active\n---\nHuman text stays.\n";

    #[test]
    fn legacy_contact_values_keep_template_and_join_semantics_distinct() {
        let result = update(
            Some(NOTE),
            "person",
            &json!({
                "aliases":[1,true,null,{},["A",null,"B"]],
                "emails":[null,false,12], "phones":[null,["1","2"]],
                "relationshipSummary":{}, "contextSummary":[1]
            }),
        )
        .unwrap();
        assert!(
            result.contains("aliases:\n  - 1\n  - true\n  - null\n  - [object Object]\n  - A,,B\n")
        );
        assert!(result.contains("emails:\n  - null\n  - false\n  - 12\n"));
        assert!(result.contains("Emails: , false, 12\nPhones: , 1,2\n"));
        assert!(result.contains("Human text stays."));
    }

    #[test]
    fn empty_strings_clear_lists_null_preserves_and_invalid_values_fail() {
        let cleared = update(
            Some(NOTE),
            "person",
            &json!({"aliases":"", "emails":"", "phones":""}),
        )
        .unwrap();
        assert!(cleared.contains("aliases: []\nemails: []\nphones: []\n"));
        let preserved = update(Some(NOTE), "person", &json!({"aliases":null})).unwrap();
        assert!(preserved.contains("aliases:\n  - Al\n"));
        for value in [
            json!({"aliases":"x"}),
            json!({"phones":{}}),
            json!({"aliases":[{"toString":null}]}),
        ] {
            assert!(update(Some(NOTE), "person", &value).is_err());
        }
        assert!(update(Some(NOTE), "another-person", &json!({})).is_err());
    }
    fn original() -> String {
        create_note(
            "person-id",
            &CreateNote {
                display_name: "Alice".into(),
                aliases: vec!["Al".into()],
                emails: vec!["alice@example.test".into()],
                phones: vec!["123".into()],
            },
        )
    }

    #[test]
    fn null_aliases_keep_the_existing_list_and_status_can_change() {
        let content = update(Some(&original()), "person-id", &json!({"aliases":null})).unwrap();
        assert_eq!(content, original());
        let content = update(Some(&content), "person-id", &json!({"status":"archived"})).unwrap();
        assert_eq!(
            parse_people_note(&content).unwrap().frontmatter.status,
            NoteStatus::Archived
        );
    }

    #[test]
    fn mixed_phones_keep_frontmatter_and_summary_null_rules_distinct() {
        let content = update(
            Some(&original()),
            "person-id",
            &json!({"phones":[23,false,null,["Nested",null],{}]}),
        )
        .unwrap();
        let note = parse_people_note(&content).unwrap();
        assert_eq!(
            note.frontmatter.phones,
            ["23", "false", "null", "Nested,", "[object Object]"]
        );
        assert!(note
            .body
            .contains("Phones: 23, false, , Nested,, [object Object]"));
        for patch in [
            json!({"aliases":{ "length":1 }}),
            json!({"emails":[{"toString":0}]}),
        ] {
            assert!(update(Some(&original()), "person-id", &patch).is_err());
        }
    }
}
