//! Tasks package data core. All effects cross the guest-safe SDK Host interface.
pub mod account;
mod approval;
mod breakdown;
pub mod dates;
mod delete_list;
mod drift;
mod heartbeat;
mod jobs;
mod list;
mod mutations;
pub mod parse;
pub mod recurrence;
pub mod repository;
mod roll_forward;
pub mod routes;
pub mod rows;
mod search_interpret;
mod summary;
pub mod task_fields;
pub mod tasks;
mod tool_fields;
mod tool_schemas;
pub mod tools;
pub mod validation;

pub mod schema;
pub mod schemas;

#[cfg(target_arch = "wasm32")]
mod component;

/// The same entry point runs natively in tests and inside the packaged component.
pub fn handle<H: moss_module_sdk::Host + ?Sized>(
    host: &H,
    kind: &str,
    payload: &str,
) -> moss_module_sdk::Result<String> {
    match kind {
        "health" | "install" => Ok("{}".into()),
        "route" => {
            let request = serde_json::from_str(payload)?;
            Ok(serde_json::to_string(&routes::handle(host, request))?)
        }
        "tool" => {
            let request = serde_json::from_str(payload)?;
            let result = tools::handle(host, request)
                .map_err(|_| moss_module_sdk::Error::new("Tasks tool failed"))?;
            Ok(serde_json::to_string(&result)?)
        }
        "job" => jobs::handle(host, payload),
        "api" => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            #[serde(tag = "name", content = "parameters")]
            enum Api {
                #[serde(rename = "prepareTaskAction")]
                Prepare(Prepare),
                #[serde(rename = "prepareTaskRoute")]
                PrepareRoute(PrepareRoute),
                #[serde(rename = "getTaskReference")]
                Reference(Reference),
            }
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Reference {
                id: String,
            }
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct PrepareRoute {
                route: String,
                params_json: Option<String>,
                query_json: Option<String>,
                body_json: Option<String>,
            }
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Prepare {
                tool: String,
                // A JSON string keeps field order, which sets the card's row order.
                input_json: String,
            }
            let api: Api = serde_json::from_str(payload)?;
            if let Api::Reference(r) = api {
                // The host reads through the caller's account, so another account's task is absent.
                let Some(task) = repository::Repository::new(host)
                    .task(&r.id)
                    .map_err(|_| moss_module_sdk::Error::new("Task reference unavailable"))?
                else {
                    return Ok(serde_json::json!({"task":null}).to_string());
                };
                let dto = task.dto(&[]);
                return Ok(serde_json::json!({"task":{
                    "id":dto["id"],"ownerUserId":dto["ownerUserId"],
                    "status":dto["status"],"dueAt":dto["dueAt"]}})
                .to_string());
            }
            Ok(match api {
                Api::Prepare(request) => {
                    approval::prepare(host, &request.tool, &request.input_json)
                }
                Api::Reference(_) => unreachable!(),
                Api::PrepareRoute(r) => approval::prepare_route(
                    host,
                    &r.route,
                    r.params_json.as_deref(),
                    r.query_json.as_deref(),
                    r.body_json.as_deref(),
                ),
            }
            .to_string())
        }
        _ => Err(moss_module_sdk::Error::new("Unsupported Tasks invocation")),
    }
}
