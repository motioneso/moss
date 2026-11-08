//! Partial route wiring. Installed dispatch and legacy fallback/error mapping remain open.
use crate::{
    note_edits::{CreateNote, UpdateNote},
    notes_format::NoteStatus,
    notes_service::NotesService,
};
use moss_module_sdk::{Error, Host, Response, Result, RouteRequest};

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let request: RouteRequest = serde_json::from_str(payload)?;
    let service = NotesService::new(host);
    let id = || {
        request
            .params
            .get("id")
            .map(String::as_str)
            .ok_or_else(|| Error::new("Missing person ID"))
    };
    let value = match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/people") => {
            service.create(&serde_json::from_value::<CreateNote>(request.body)?)?
        }
        ("POST", "/people/notes/refresh") => service.refresh()?,
        ("PATCH", "/people/:id") => service.update(
            id()?,
            &serde_json::from_value::<UpdateNote>(request.body.clone())?,
        )?,
        ("POST", "/people/:id/archive") => service.update(
            id()?,
            &UpdateNote {
                status: Some(NoteStatus::Archived),
                ..UpdateNote::default()
            },
        )?,
        _ => return Err(Error::new("Unknown People route")),
    };
    Ok(serde_json::to_string(&Response::new(200, value))?)
}
