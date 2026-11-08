use crate::js_space;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock};

pub const PEOPLE_MANAGED_START: &str = "<!-- jarvis:people:start -->";
pub const PEOPLE_MANAGED_END: &str = "<!-- jarvis:people:end -->";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Frontmatter {
    pub jarvis_person_id: Option<String>,
    pub display_name: String,
    pub aliases: Vec<String>,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
    pub status: NoteStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NoteStatus {
    Active,
    Archived,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PeopleNote {
    pub frontmatter: Frontmatter,
    pub body: String,
}

enum Field {
    Scalar(String),
    Array(Vec<String>),
}

fn parse_frontmatter(block: &str) -> Option<Frontmatter> {
    static KEY: OnceLock<Regex> = OnceLock::new();
    let key = KEY.get_or_init(|| Regex::new(r"^([A-Za-z][A-Za-z0-9]*):(.*)$").unwrap());
    let mut fields = HashMap::<String, Field>::new();
    let mut current_array: Option<String> = None;
    for raw in block.split('\n') {
        let line = raw.trim_end_matches(js_space);
        if line.trim_matches(js_space).is_empty() {
            continue;
        }
        let item = line.trim_start_matches(js_space).strip_prefix('-');
        if let (Some(item), Some(current)) = (item, current_array.as_ref()) {
            // The JS pattern's (.+) requires at least one character after the hyphen.
            if !item.is_empty() {
                if let Some(Field::Array(items)) = fields.get_mut(current) {
                    items.push(item.trim_matches(js_space).into());
                    continue;
                }
            }
        }
        let captures = key.captures(line)?;
        let name = captures.get(1)?.as_str().to_string();
        let value = captures.get(2)?.as_str().trim_matches(js_space);
        current_array = None;
        if matches!(name.as_str(), "aliases" | "emails" | "phones") {
            fields.insert(name.clone(), Field::Array(vec![]));
            if value != "[]" {
                current_array = Some(name);
            }
        } else {
            fields.insert(name, Field::Scalar(value.into()));
        }
    }
    let scalar = |key: &str| match fields.get(key) {
        Some(Field::Scalar(s)) => Some(s.clone()),
        _ => None,
    };
    let array = |key: &str| match fields.get(key) {
        Some(Field::Array(a)) => a.clone(),
        _ => vec![],
    };
    let display_name = scalar("displayName")?;
    if display_name.trim_matches(js_space).is_empty() {
        return None;
    }
    let status = match scalar("status")?.as_str() {
        "active" => NoteStatus::Active,
        "archived" => NoteStatus::Archived,
        _ => return None,
    };
    Some(Frontmatter {
        jarvis_person_id: scalar("jarvisPersonId").filter(|s| !s.is_empty()),
        display_name,
        aliases: array("aliases"),
        emails: array("emails"),
        phones: array("phones"),
        status,
    })
}

pub fn parse_people_note(content: &str) -> Option<PeopleNote> {
    if !content.starts_with("---\n") {
        return None;
    }
    let end = content.get(4..)?.find("\n---")? + 4;
    let frontmatter = parse_frontmatter(content.get(4..end)?)?;
    let body_start = end + 4 + usize::from(content.as_bytes().get(end + 4) == Some(&b'\n'));
    Some(PeopleNote {
        frontmatter,
        body: content.get(body_start..)?.into(),
    })
}

pub fn format_people_note(note: &PeopleNote) -> String {
    let fm = &note.frontmatter;
    let mut lines = vec!["---".into()];
    if let Some(id) = fm.jarvis_person_id.as_ref().filter(|s| !s.is_empty()) {
        lines.push(format!("jarvisPersonId: {id}"));
    }
    lines.push(format!("displayName: {}", fm.display_name));
    for (name, values) in [
        ("aliases", &fm.aliases),
        ("emails", &fm.emails),
        ("phones", &fm.phones),
    ] {
        if values.is_empty() {
            lines.push(format!("{name}: []"));
        } else {
            lines.push(format!("{name}:"));
            lines.extend(values.iter().map(|v| format!("  - {v}")));
        }
    }
    lines.push(format!(
        "status: {}",
        match fm.status {
            NoteStatus::Active => "active",
            NoteStatus::Archived => "archived",
        }
    ));
    lines.push("---".into());
    lines.push(note.body.clone());
    format!("{}\n", lines.join("\n").trim_end_matches(js_space))
}

pub fn replace_moss_managed_section(body: &str, managed: &str) -> String {
    let section = format!(
        "{PEOPLE_MANAGED_START}\n{}\n{PEOPLE_MANAGED_END}",
        managed.trim_matches(js_space)
    );
    if let Some(start) = body.find(PEOPLE_MANAGED_START) {
        if let Some(end) = body[start + PEOPLE_MANAGED_START.len()..].find(PEOPLE_MANAGED_END) {
            let end = start + PEOPLE_MANAGED_START.len() + end + PEOPLE_MANAGED_END.len();
            return format!("{}{section}{}", &body[..start], &body[end..]);
        }
    }
    format!("{}\n\n{section}\n", body.trim_end_matches(js_space))
}
