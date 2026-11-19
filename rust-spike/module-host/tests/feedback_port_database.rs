//! The feedback port against the real database with row-level security, through the real guest
//! and service ports. Run only through the proactive feedback gate.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    feedback_port::PostgresFeedback,
    local::LocalPorts,
    manifest::{Capability, Manifest},
    runtime::{CallScope, Host, Limits, Request},
    services::ServicePorts,
};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::SecretCipher,
};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured embeddings")
    }
}

fn manifest(resources: &[&str]) -> Manifest {
    let mut m = common::manifest("1.0.0");
    m.capabilities = vec![Capability {
        port: "feedback".into(),
        operations: ["record".into(), "undo".into(), "active".into()].into(),
        resources: resources.iter().map(|r| r.to_string()).collect(),
        allow_private: false,
    }];
    m
}

#[test]
#[ignore = "Only through the proactive feedback gate"]
fn ratings_through_the_port_belong_to_the_caller_and_stay_private() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    let bootstrap = rt.block_on(async {
        let (db, conn) = tokio_postgres::connect(
            &std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        for id in [a, b] {
            db.execute(
                "INSERT INTO app.users(id,email,name) VALUES($1,$2,'Feedback port proof')",
                &[&id, &format!("{id}@example.test")],
            )
            .await
            .unwrap();
        }
        db
    });
    let database = rt
        .block_on(Database::connect(
            &std::env::var("JS43_APP_URL").unwrap(),
            4,
            RuntimeRole::App,
        ))
        .unwrap();
    let data = tempfile::tempdir().unwrap();
    let services = Arc::new(
        ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap()
        .with_feedback(Arc::new(PostgresFeedback::new(database).unwrap())),
    );
    let host = Host::new(Limits::default()).unwrap();
    let wasm = wat::parse_str(
        include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/feedback@"),
    )
    .unwrap();
    let m = manifest(&["briefing_item", "briefing_run"]);
    let call = |who: Uuid, op: &str, resource: &str, parameters: Value| -> anyhow::Result<Value> {
        let reply = host.call(
            &wasm,
            Arc::new(m.clone()),
            AccessContext::new(who, "feedback-port-proof"),
            services.clone(),
            "route",
            &json!({"operation":op,"resource":resource,"parameters":parameters}).to_string(),
        )?;
        Ok(serde_json::from_str(&reply)?)
    };
    let dismiss = |item: &str| {
        json!({"targetRef":item,"surface":"briefing","kind":"dismiss","sourceKind":"briefings",
               "sourceLabel":"Briefings",
               "metadata":{"runId":"run-1","title":"PLANTED-ITEM-TEXT-77","summary":"PLANTED-ITEM-TEXT-77"}})
    };

    // A rates an item and a whole run. Both write their target row and their rating.
    let item = call(a, "record", "briefing_item", dismiss("run-1:item-1")).unwrap();
    let item_id = item["id"].as_str().unwrap().to_owned();
    let run_rating = call(
        a,
        "record",
        "briefing_run",
        json!({"targetRef":"run-1","surface":"briefing","kind":"not_useful"}),
    )
    .unwrap();
    assert!(run_rating["id"].as_str().is_some());
    let row = rt
        .block_on(bootstrap.query_one(
            "SELECT owner_user_id, target_kind, status, metadata_json FROM app.usefulness_feedback_signals WHERE id=$1",
            &[&Uuid::parse_str(&item_id).unwrap()],
        ))
        .unwrap();
    assert_eq!(row.get::<_, Uuid>(0), a, "the caller owns the rating");
    assert_eq!(row.get::<_, String>(1), "briefing_item");
    assert_eq!(row.get::<_, String>(2), "active");
    let targets = rt
        .block_on(bootstrap.query(
            "SELECT owner_user_id, metadata_json FROM app.usefulness_feedback_targets WHERE owner_user_id=$1",
            &[&a],
        ))
        .unwrap();
    assert_eq!(
        targets.len(),
        2,
        "one target row for the item, one for the run"
    );
    for stored in targets
        .iter()
        .map(|t| t.get::<_, Value>(1))
        .chain([row.get::<_, Value>(3)])
    {
        assert!(
            !stored.to_string().contains("PLANTED"),
            "item text stored: {stored}"
        );
    }

    // The same rating again does not make a second row.
    assert_eq!(
        call(a, "record", "briefing_item", dismiss("run-1:item-1")).unwrap()["id"],
        item["id"]
    );

    // A sees it; B sees nothing and cannot undo it.
    let active = |who| {
        call(
            who,
            "active",
            "briefing_item",
            json!({"surface":"briefing","kind":"dismiss"}),
        )
        .unwrap()
    };
    assert_eq!(active(a), json!({"refs":["run-1:item-1"]}));
    assert_eq!(active(b), json!({"refs":[]}));
    assert!(call(b, "undo", "briefing_item", json!({"id":item_id})).is_err());
    assert_eq!(active(a), json!({"refs":["run-1:item-1"]}));

    // A rating cannot be undone through a different target kind.
    assert!(call(a, "undo", "briefing_run", json!({"id":item_id})).is_err());

    // A can take it back.
    call(a, "undo", "briefing_item", json!({"id":item_id})).unwrap();
    assert_eq!(active(a), json!({"refs":[]}));

    // A kind the pair rules reject is refused with nothing written.
    assert!(call(
        a,
        "record",
        "briefing_item",
        json!({"targetRef":"x","surface":"chat","kind":"dismiss"})
    )
    .is_err());

    for who in [a, b] {
        rt.block_on(bootstrap.execute("DELETE FROM app.users WHERE id=$1", &[&who]))
            .unwrap();
    }
    println!("feedback port: owner pinned, other account blind, text never stored");
}
