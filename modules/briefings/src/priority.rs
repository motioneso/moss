//! Priority. The scorer and the person's saved priority model are not built in this app yet, so
//! gathering hands the later writing step plain candidates and names the model as a source gap.
use crate::gather_types::Section;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub source: &'static str,
    pub title: String,
    pub due_at: Option<String>,
    pub starts_at: Option<String>,
    pub explicit_priority: Option<i64>,
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|t| !t.is_empty()).map(str::to_owned)
}

/// Candidates from the raw items of the tasks, calendar and email sections. Mail ranks by its
/// own triage, so it carries a title and nothing else.
pub fn candidates(sections: &[Section]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for section in sections {
        for item in &section.raw {
            let (source, title) = match section.key {
                "tasks" => ("tasks", &item["title"]),
                "calendar" => ("calendar", &item["title"]),
                "email" => ("email", &item["subject"]),
                _ => continue,
            };
            let Some(title) = text(title) else { continue };
            out.push(Candidate {
                source,
                title,
                due_at: text(&item["dueAt"]),
                starts_at: text(&item["startsAt"]),
                explicit_priority: item["priority"].as_i64(),
            });
        }
    }
    out
}
