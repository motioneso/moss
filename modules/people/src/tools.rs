//! Execution after host authorization. This handler cannot mint an approval or
//! remove the host's route/app-action blocks. Installed chat wiring is separate.
use crate::repository::Repository;
use moss_module_sdk::{Error, Host, Result};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    tool: String,
    parameters: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolve {
    query: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Person {
    person_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Recent {
    limit: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    candidate_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Merge {
    primary_person_id: String,
    secondary_person_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Split {
    identity_id: String,
    target_person_id: Option<String>,
    new_person_display_name: Option<String>,
}

pub fn handle(host: &impl Host, payload: &str) -> Result<String> {
    let request: Request = serde_json::from_str(payload)?;
    let repo = Repository::new(host);
    let result = match request.tool.as_str() {
        "people.resolve" => {
            let args: Resolve = serde_json::from_value(request.parameters)?;
            json!({"data":{"person":repo.resolve(&args.query)?}})
        }
        "people.getContext" => {
            let args: Person = serde_json::from_value(request.parameters)?;
            let person = repo.detail(&args.person_id)?;
            let mut links = repo.links(&args.person_id, None, None, None)?;
            for link in &mut links {
                link["citationToken"] = json!(format!(
                    "{}:{}:{}",
                    link["sourceKind"]
                        .as_str()
                        .ok_or_else(|| Error::new("Invalid link source"))?,
                    link["sourceRefHash"]
                        .as_str()
                        .ok_or_else(|| Error::new("Invalid link reference"))?,
                    link["id"]
                        .as_str()
                        .ok_or_else(|| Error::new("Invalid link ID"))?
                ));
            }
            json!({"data":{"person":person,"links":links},"columnOrder":["id","linkKind","summary","occurredAt","citationToken"]})
        }
        "people.listRecent" => {
            let args: Recent = serde_json::from_value(request.parameters)?;
            if args.limit.is_some_and(|limit| limit > 100) {
                return Err(Error::new("People list limit exceeds one hundred"));
            }
            json!({"data":{"items":repo.list_people(None,None,Some(args.limit.unwrap_or(20)))?},
                "columnOrder":["id","displayName","status","updatedAt"]})
        }
        "people.acceptMatch" => {
            let args: Candidate = serde_json::from_value(request.parameters)?;
            repo.accept_candidate(&args.candidate_id)?;
            json!({"data":{"accepted":true}})
        }
        "people.rejectMatch" => {
            let args: Candidate = serde_json::from_value(request.parameters)?;
            repo.reject_candidate(&args.candidate_id)?;
            json!({"data":{"rejected":true}})
        }
        "people.merge" => {
            let args: Merge = serde_json::from_value(request.parameters)?;
            json!({"data":{"person":repo.merge(&args.primary_person_id,&args.secondary_person_id)?}})
        }
        "people.splitIdentity" => {
            let args: Split = serde_json::from_value(request.parameters)?;
            json!({"data":{"person":repo.split_identity(&args.identity_id,args.target_person_id.as_deref(),args.new_person_display_name.as_deref())?}})
        }
        _ => return Err(Error::new("Unknown People tool")),
    };
    Ok(serde_json::to_string(&result)?)
}
