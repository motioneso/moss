use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use moss_people::repository::{Repository, TABLES};
use serde_json::{json, Value};

pub fn run(host: &impl Host) -> Result<Value> {
    let repo = Repository::new(host);
    let alpha = repo.find_or_create_person("Mutation Alpha")?;
    let beta = repo.find_or_create_person("Mutation Beta")?;
    let identity_input = json!({"personId":alpha["id"],"identityKind":"email_address","sourceKind":"email","normalizedValue":"mutation@example.test","displayValue":"Initial address","sourceRef":"initial-ref","sourceRefHash":"initial-hash","status":"active","confidence":0.6,"provenance":"source"});
    let identity = repo.upsert_identity(&serde_json::from_value(identity_input.clone())?)?;
    let mut again = identity_input.clone();
    again["personId"] = beta["id"].clone();
    again["displayValue"] = json!("Changed address");
    again["confidence"] = json!(0.9);
    again["sourceRef"] = json!("ignored-ref");
    let identity_again = repo.upsert_identity(&serde_json::from_value(again)?)?;
    let mut alias = identity_input;
    alias["identityKind"] = json!("alias");
    alias["sourceKind"] = json!("manual");
    alias["normalizedValue"] = json!("same alias");
    alias["displayValue"] = json!("Same Alias");
    let alias_first = repo.upsert_identity(&serde_json::from_value(alias.clone())?)?;
    let alias_second = repo.upsert_identity(&serde_json::from_value(alias)?)?;
    let link_input = json!({"personId":beta["id"],"sourceKind":"email","sourceRef":"first-ref","sourceRefHash":"mutation-link","linkKind":"sender","sourceLabel":"First label","summary":"First summary","occurredAt":"2020-01-01T00:00:00Z","confidence":0.6});
    let link = repo.upsert_link(&serde_json::from_value(link_input.clone())?)?;
    let mut again = link_input;
    again["sourceRef"] = json!("ignored-ref");
    again["sourceLabel"] = json!("Changed label");
    again["summary"] = json!("Changed summary");
    again["occurredAt"] = json!("2021-01-01T00:00:00Z");
    again["confidence"] = json!(0.9);
    let link_again = repo.upsert_link(&serde_json::from_value(again)?)?;
    let link_id = link["id"].as_str().unwrap();
    let identity_id = identity["id"].as_str().unwrap();
    let source =
        repo.upsert_link_source(link_id, Some(identity_id), "source-hash", "sender", 0.6)?;
    let source_again = repo.upsert_link_source(link_id, None, "source-hash", "sender", 0.9)?;
    let candidate_input = json!({"candidateKind":"link_identity","primaryPersonId":alpha["id"],"identityId":identity["id"],"reasonSummary":"Original reason","confidence":0.6,"ids":["mutation-case"]});
    let candidate = repo.upsert_candidate(&serde_json::from_value(candidate_input.clone())?)?;
    let candidate_id = candidate["id"].as_str().unwrap();
    repo.reject_candidate(candidate_id)?;
    let rejected = repo.candidate(candidate_id)?;
    let mut again = candidate_input;
    again["reasonSummary"] = json!("Ignored reason");
    again["confidence"] = json!(0.9);
    let candidate_again = repo.upsert_candidate(&serde_json::from_value(again)?)?;
    repo.accept_candidate(candidate_id)?;
    let accepted = repo.candidate(candidate_id)?;
    let merged = repo.merge(alpha["id"].as_str().unwrap(), beta["id"].as_str().unwrap())?;
    let split = repo.split_identity(identity_id, None, Some("Mutation New"))?;
    let responses = json!({"alpha":alpha,"beta":beta,"identity":identity,"identityAgain":identity_again,"aliasFirst":alias_first,"aliasSecond":alias_second,"link":link,"linkAgain":link_again,"source":source,"sourceAgain":source_again,"candidate":candidate,"rejected":rejected,"candidateAgain":candidate_again,"accepted":accepted,"merged":merged,"split":split});
    let mut rows = serde_json::Map::new();
    for table in TABLES {
        rows.insert(
            table.into(),
            json!(Client(host).query(
                table,
                &Query {
                    limit: Some(1000),
                    ..Query::select(Filter::Owned)
                }
            )?),
        );
    }
    Ok(json!({"responses":responses,"rows":rows}))
}
