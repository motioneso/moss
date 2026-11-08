//! Canonical note decisions. The host supplies fresh content under its mutation lock and
//! applies the result; this module never opens a path or chooses an account's allowed roots.
use crate::{
    js_space,
    notes_format::{
        format_people_note, parse_people_note, replace_moss_managed_section, Frontmatter,
        NoteStatus, PeopleNote,
    },
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNote {
    pub display_name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default)]
    pub phones: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNote {
    pub display_name: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub emails: Option<Vec<String>>,
    pub phones: Option<Vec<String>>,
    pub status: Option<NoteStatus>,
    // The current note-backed service accepts these fields but does not project them.
    // Keep that behavior instead of inventing a second source of truth for summaries.
    pub relationship_summary: Option<String>,
    pub context_summary: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditError {
    CanonicalNoteNotFound,
    DestinationExists,
}
impl std::fmt::Display for EditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::CanonicalNoteNotFound => "Canonical People note not found",
            Self::DestinationExists => "People note destination already exists",
        })
    }
}
impl std::error::Error for EditError {}

/// The first available destination wins, using the same two names as the existing service.
/// Availability must be checked again by the host while applying the write.
pub fn destination_names(display_name: &str, person_id: &str) -> [String; 2] {
    let mut slug = String::new();
    let mut separator = false;
    for c in display_name.trim_matches(js_space).chars() {
        if c.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(c);
            separator = false;
        } else {
            separator = true;
        }
    }
    if slug.is_empty() {
        slug.push_str("Person");
    }
    let short_id: String = person_id.chars().take(8).collect();
    [format!("{slug}.md"), format!("{slug}-{short_id}.md")]
}

pub fn select_destination<'a>(
    names: &'a [String; 2],
    current: &[Option<String>; 2],
) -> Result<&'a str, EditError> {
    names
        .iter()
        .zip(current)
        .find_map(|(path, content)| content.is_none().then_some(path.as_str()))
        .ok_or(EditError::DestinationExists)
}

fn managed_summary(fm: &Frontmatter) -> String {
    let mut lines = vec![format!("Display name: {}", fm.display_name)];
    if !fm.emails.is_empty() {
        lines.push(format!("Emails: {}", fm.emails.join(", ")));
    }
    if !fm.phones.is_empty() {
        lines.push(format!("Phones: {}", fm.phones.join(", ")));
    }
    lines.join("\n")
}

pub fn create_note(person_id: &str, input: &CreateNote) -> String {
    let frontmatter = Frontmatter {
        jarvis_person_id: Some(person_id.into()),
        display_name: input.display_name.clone(),
        aliases: input.aliases.clone(),
        emails: input.emails.clone(),
        phones: input.phones.clone(),
        status: NoteStatus::Active,
    };
    let body = replace_moss_managed_section(
        &format!("# {}\n", input.display_name),
        &managed_summary(&frontmatter),
    );
    format_people_note(&PeopleNote { frontmatter, body })
}

/// `current` is the content re-read during coordinated mutation, not an earlier screen read.
/// Recheck the canonical ID before altering anything and preserve the human body.
pub fn update_note(
    current: Option<&str>,
    person_id: &str,
    patch: &UpdateNote,
) -> Result<String, EditError> {
    let mut note = current
        .and_then(parse_people_note)
        .filter(|note| note.frontmatter.jarvis_person_id.as_deref() == Some(person_id))
        .ok_or(EditError::CanonicalNoteNotFound)?;
    let fm = &mut note.frontmatter;
    if let Some(value) = &patch.display_name {
        fm.display_name.clone_from(value);
    }
    if let Some(value) = &patch.aliases {
        fm.aliases.clone_from(value);
    }
    if let Some(value) = &patch.emails {
        fm.emails.clone_from(value);
    }
    if let Some(value) = &patch.phones {
        fm.phones.clone_from(value);
    }
    if let Some(value) = &patch.status {
        fm.status = value.clone();
    }
    note.body = replace_moss_managed_section(&note.body, &managed_summary(fm));
    Ok(format_people_note(&note))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NoteFile {
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug)]
pub struct LoadedNote {
    pub path: String,
    pub parsed: PeopleNote,
}

/// Projection records supplied by the repository, already scoped to the authenticated actor.
pub struct ExistingPerson {
    pub id: String,
    pub merged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewNote {
    pub reason_summary: &'static str,
    pub ids: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RefreshPlan {
    pub discovered: usize,
    pub ignored: usize,
    pub projections: Vec<LoadedNote>,
    pub reviews: Vec<ReviewNote>,
}

pub fn refresh_plan(files: &[NoteFile], people: &[ExistingPerson]) -> RefreshPlan {
    let mut plan = RefreshPlan::default();
    // Preserve first-seen ordering, like the current Map; UUID order is not note order.
    let mut groups: Vec<(String, Vec<LoadedNote>)> = Vec::new();
    for file in files.iter().filter(|file| file.path.ends_with(".md")) {
        plan.discovered += 1;
        let Some(parsed) = parse_people_note(&file.content) else {
            plan.ignored += 1;
            continue;
        };
        let Some(id) = parsed.frontmatter.jarvis_person_id.clone() else {
            plan.reviews.push(ReviewNote {
                reason_summary: "People note missing jarvisPersonId",
                ids: vec![file.path.clone()],
            });
            continue;
        };
        let loaded = LoadedNote {
            path: file.path.clone(),
            parsed,
        };
        if let Some((_, notes)) = groups.iter_mut().find(|(key, _)| key == &id) {
            notes.push(loaded);
        } else {
            groups.push((id, vec![loaded]));
        }
    }
    for (id, notes) in &groups {
        if notes.len() == 1 {
            plan.projections.push(notes[0].clone());
        } else {
            plan.reviews.push(ReviewNote {
                reason_summary: "Duplicate canonical People notes",
                ids: std::iter::once(id.clone())
                    .chain(notes.iter().map(|note| note.path.clone()))
                    .collect(),
            });
        }
    }
    for person in people {
        if !person.merged && !groups.iter().any(|(id, _)| id == &person.id) {
            plan.reviews.push(ReviewNote {
                reason_summary: "Existing People record missing canonical note",
                ids: vec![person.id.clone()],
            });
        }
    }
    plan
}

pub fn find_canonical_note(files: &[NoteFile], person_id: &str) -> Result<LoadedNote, EditError> {
    let mut matches = files
        .iter()
        .filter(|file| file.path.ends_with(".md"))
        .filter_map(|file| {
            let parsed = parse_people_note(&file.content)?;
            (parsed.frontmatter.jarvis_person_id.as_deref() == Some(person_id)).then(|| {
                LoadedNote {
                    path: file.path.clone(),
                    parsed,
                }
            })
        });
    let found = matches.next().ok_or(EditError::CanonicalNoteNotFound)?;
    if matches.next().is_some() {
        return Err(EditError::CanonicalNoteNotFound);
    }
    Ok(found)
}
