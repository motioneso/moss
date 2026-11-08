//! Canonical People notes, through the merged host's bounded linked-notes contract.
//! The caller finalizes the invocation; file compensation is not crash-safe atomicity.
use crate::{
    matching::normalize_identity,
    note_edits::{self, CreateNote, ExistingPerson, NoteFile, UpdateNote},
    notes_format::{parse_people_note, NoteStatus, PeopleNote},
    repository::{PersonProjection, Repository},
    repository_mutations::{CandidateInput, IdentityInput},
};
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const RESOURCE: &str = "people-notes";
const UNAVAILABLE: &str = "People notes folder is unavailable";
#[derive(Deserialize)]
struct CurrentNote {
    path: String,
    #[serde(rename = "destinationId")]
    destination_id: String,
    content: Option<String>,
}

pub struct NotesService<'a, H: Host + ?Sized> {
    host: &'a H,
    repo: Repository<'a, H>,
}
impl<'a, H: Host + ?Sized> NotesService<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self {
            host,
            repo: Repository::new(host),
        }
    }
    fn read(&self, path: &str) -> Result<CurrentNote> {
        Ok(serde_json::from_value(
            self.host
                .call("vault", "notes.read", RESOURCE, json!({"path":path}))
                .map_err(|_| Error::new(UNAVAILABLE))?,
        )?)
    }
    fn write(&self, current: &CurrentNote, content: &str) -> Result<()> {
        self.host.call("vault", "notes.compare-write", RESOURCE,
            json!({"path":current.path,"destinationId":current.destination_id,"expected":current.content,"content":content}))?;
        Ok(())
    }
    fn files(&self) -> Result<Vec<NoteFile>> {
        let mut directories = vec![String::new()];
        let mut files = vec![];
        let mut total = 0usize;
        let mut bytes = 0usize;
        while let Some(directory) = directories.pop() {
            let listing = self
                .host
                .call("vault", "notes.list", RESOURCE, json!({"path":directory}))
                .map_err(|_| Error::new(UNAVAILABLE))?;
            let entries = listing["entries"]
                .as_array()
                .ok_or_else(|| Error::new("Invalid notes listing"))?;
            total += entries.len();
            if total > 2000 {
                return Err(Error::new("People folder exceeds the note scan limit"));
            }
            // The host supplies confined immediate names; guests never choose an absolute root.
            for entry in entries {
                let name = entry["name"]
                    .as_str()
                    .ok_or_else(|| Error::new("Invalid note name"))?;
                let path = if directory.is_empty() {
                    name.into()
                } else {
                    format!("{directory}/{name}")
                };
                match entry["kind"].as_str() {
                    Some("directory") => directories.push(path),
                    Some("file") => {
                        let current = self.read(&path)?;
                        // A disappearing file is a conflict, not an empty note to project.
                        let content = current
                            .content
                            .ok_or_else(|| Error::new("People note changed during refresh"))?;
                        bytes += content.len();
                        if bytes > 4 * 1024 * 1024 {
                            return Err(Error::new(
                                "People folder exceeds the note scan size limit",
                            ));
                        }
                        files.push(NoteFile { path, content });
                    }
                    _ => return Err(Error::new("Invalid notes entry")),
                }
            }
        }
        Ok(files)
    }
    fn project(&self, path: &str, parsed: &PeopleNote) -> Result<Value> {
        let fm = &parsed.frontmatter;
        let id = fm
            .jarvis_person_id
            .as_deref()
            .ok_or_else(|| Error::new("People note missing jarvisPersonId"))?;
        let person = self.repo.project_person(&PersonProjection {
            id,
            display_name: &fm.display_name,
            relationship: None,
            context: None,
            status: match fm.status {
                NoteStatus::Active => "active",
                NoteStatus::Archived => "archived",
            },
            confidence: 1.0,
        })?;
        self.repo.delete_note_identities(id)?;
        for (kind, hash_kind, values) in [
            ("alias", "alias", &fm.aliases),
            ("email_address", "email", &fm.emails),
        ] {
            for value in values {
                self.repo.upsert_identity(&IdentityInput {
                    person_id: Some(id.into()),
                    identity_kind: kind.into(),
                    source_kind: "note".into(),
                    normalized_value: normalize_identity(kind, value),
                    display_value: value.clone(),
                    source_ref: Some(path.into()),
                    source_ref_hash: Some(
                        format!(
                            "{:x}",
                            Sha256::digest(format!("{path}:{hash_kind}:{value}").as_bytes())
                        )[..32]
                            .into(),
                    ),
                    status: Some("active".into()),
                    confidence: Some(1.0),
                    provenance: Some("user_confirmed".into()),
                })?;
            }
        }
        Ok(person)
    }
    pub fn create(&self, input: &CreateNote) -> Result<Value> {
        let id = self.host.call("context", "uuid", "new", json!({}))?["id"]
            .as_str()
            .ok_or_else(|| Error::new("Missing host-generated person ID"))?
            .to_owned();
        let content = note_edits::create_note(&id, input);
        let names = note_edits::destination_names(&input.display_name, &id);
        // Read both destinations before choosing; an existing empty file is occupied.
        let current = [self.read(&names[0])?, self.read(&names[1])?];
        let selected = current
            .iter()
            .find(|n| n.content.is_none())
            .ok_or_else(|| Error::new("People note destination already exists"))?;
        self.write(selected, &content)?;
        let parsed = parse_people_note(&content)
            .ok_or_else(|| Error::new("Invalid canonical People note"))?;
        let person = self.project(&selected.path, &parsed)?;
        Ok(json!({"person":person,"notePath":selected.path}))
    }
    pub fn update(&self, id: &str, patch: &UpdateNote) -> Result<Value> {
        let (current, content) = self.prepare_update(id, patch)?;
        self.publish_update(&current, &content)
    }
    fn prepare_update(&self, id: &str, patch: &UpdateNote) -> Result<(CurrentNote, String)> {
        let note = note_edits::find_canonical_note(&self.files()?, id)
            .map_err(|e| Error::new(e.to_string()))?;
        // Read again after discovery, and recheck its canonical ID before compare-write.
        let current = self.read(&note.path)?;
        let content = note_edits::update_note(current.content.as_deref(), id, patch)
            .map_err(|e| Error::new(e.to_string()))?;
        Ok((current, content))
    }
    fn publish_update(&self, current: &CurrentNote, content: &str) -> Result<Value> {
        self.write(current, content)?;
        let parsed = parse_people_note(content)
            .ok_or_else(|| Error::new("Invalid canonical People note"))?;
        let person = self.project(&current.path, &parsed)?;
        Ok(json!({"person":person,"notePath":current.path}))
    }
    pub fn refresh(&self) -> Result<Value> {
        self.refresh_files(self.files()?)
    }
    /// Only pre-publication failures permit the old projection-only HTTP fallback.
    /// Compare-write, projection and finalization failures abort the whole call.
    pub fn update_for_route(&self, id: &str, patch: &UpdateNote) -> Result<Option<Value>> {
        let (current, content) = match self.prepare_update(id, patch) {
            Ok(prepared) => prepared,
            Err(error)
                if error.message == UNAVAILABLE
                    || error.message
                        == note_edits::EditError::CanonicalNoteNotFound.to_string() =>
            {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        self.publish_update(&current, &content).map(Some)
    }
    pub fn refresh_for_route(&self) -> Result<Option<Value>> {
        let files = match self.files() {
            Ok(files) => files,
            Err(error) if error.message == UNAVAILABLE => return Ok(None),
            Err(error) => return Err(error),
        };
        self.refresh_files(files).map(Some)
    }
    fn refresh_files(&self, files: Vec<NoteFile>) -> Result<Value> {
        let people: Vec<_> = self
            .repo
            .list_people(None, None, None)?
            .into_iter()
            .map(|person| {
                Ok(ExistingPerson {
                    id: person["id"]
                        .as_str()
                        .ok_or_else(|| Error::new("Invalid person ID"))?
                        .into(),
                    merged: person["status"] == "merged",
                })
            })
            .collect::<Result<_>>()?;
        let plan = note_edits::refresh_plan(&files, &people);
        for note in &plan.projections {
            self.project(&note.path, &note.parsed)?;
        }
        for review in &plan.reviews {
            self.repo.upsert_candidate(&CandidateInput {
                candidate_kind: "create_person".into(),
                primary_person_id: None,
                secondary_person_id: None,
                identity_id: None,
                suggested_display_name: None,
                reason_summary: Some(review.reason_summary.into()),
                confidence: Some(0.5),
                ids: review.ids.clone(),
            })?;
        }
        Ok(
            json!({"discovered":plan.discovered,"projected":plan.projections.len(),"ignored":plan.ignored,"candidates":plan.reviews.len()}),
        )
    }
}
