//! Apply the legacy route schema inside the guest, including Ajv coercion and
//! removal of unknown body fields. Direct host calls get the same validation.
use crate::{repository::Error, schema::Schema, schemas};
use moss_module_sdk::RouteRequest;

pub fn request_schema(method: &str, path: &str) -> Option<Schema> {
    match (method, path) {
        ("POST", "/tasks") => Some(schemas::create_task()),
        ("PATCH", "/tasks/:id") => Some(schemas::update_task()),
        ("POST", "/tasks/:id/activity") => Some(schemas::add_activity()),
        ("POST", "/tasks/:id/tags") => Some(schemas::assign_tag()),
        ("PATCH", "/tasks/preferences") => Some(schemas::update_preferences()),
        ("POST", "/tasks/lists" | "/tasks/lists/:list_id/tags")
        | ("PATCH", "/tasks/lists/:list_id" | "/tasks/lists/:list_id/tags/:tag_id") => {
            Some(schemas::name_only())
        }
        _ => None,
    }
}

pub fn validate(request: &mut RouteRequest) -> Result<(), Error> {
    if let Some(schema) = request_schema(&request.method, &request.path) {
        crate::schema::validate(&schema, &mut request.body, "body")
            .map_err(|failure| Error::http(400, failure.message))?;
    }
    Ok(())
}
