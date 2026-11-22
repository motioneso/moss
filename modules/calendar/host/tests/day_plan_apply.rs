//! The day-plan apply routes against the real database, the real installed
//! guest and the real host services, with a scripted Connectors package. This
//! is the security proof: row security keeps another account's plans and
//! operations invisible (404, nothing written) across apply, retry, recover and
//! confirm; the host-stored approval is owner-scoped so a foreign approval
//! reads as unavailable; a replayed idempotency key returns the stored result;
//! and each protection is seen failing once with row security disabled, then
//! passing again. Run only through verify-gate (see tools/gate.sh).
#[path = "support/mod.rs"]
mod support;
#[path = "support/apply_guard.rs"]
mod apply_guard;
#[path = "support/registry.rs"]
#[allow(dead_code)]
mod registry;
use apply_guard::Guard;
use moss_module_host::{
    application::{Application, Configuration},
    registry::Source,
    runtime::Ports,
};
use safety_core::secret::{Secret, SecretCipher};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

struct NoAi;
impl moss_module_host::ai::Intelligence for NoAi {
    fn generate(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("Calendar data has no AI")
    }
    fn embed(
        &self,
        _: &moss_module_host::runtime::CallScope,
        _: &moss_module_host::runtime::Request,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("Calendar data has no embeddings")
    }
}

/// The day-plan tables and the approvals store, whose row security this proof
/// removes once each to show the assertions can detect it.
const DAY_PLAN_TABLES: [&str; 4] = [
    "app.day_plans",
    "app.day_plan_blocks",
    "app.day_plan_operations",
    "app.day_plan_operation_items",
];

#[test]
#[ignore = "Only through verify-gate"]
fn apply_retry_recover_and_confirm_are_owner_scoped_and_settle_once() {
    let f = support::Fixture::new();
    f.rt.block_on(async {
        f.root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
        f.root.batch_execute(moss_module_host::jobs::MIGRATION).await.unwrap();
        // The host approval store the confirm route depends on.
        f.root.batch_execute(moss_module_host::approval_port::MIGRATION).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let registry_folder = tempfile::tempdir().unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = moss_calendar_host::package::pack(&root, &f.core()).unwrap();
    let (key, publisher, artifacts) = registry::publish_with_tasks(registry_folder.path(), &bytes);
    let database = f.db.clone();
    let stand_in = Arc::new(apply_guard::StandIn::default());
    let observing = stand_in.clone();
    let app = Application::open_extended_with(
        dir.path(),
        f.db.clone(),
        f.access(f.a),
        Configuration {
            migrations: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            producer: Secret::new(std::env::var("JS48_BOOTSTRAP_URL").unwrap()),
            cipher: Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            intelligence: Arc::new(NoAi),
            version: "0.1.0".parse().unwrap(),
            compiled_cache: None,
            fuel_ceiling: None,
            browser_dir: None,
        },
        move |next| {
            let guarded: Arc<dyn Ports> = Arc::new(
                moss_calendar_host::CalendarPorts::new(database.clone(), next.clone())?,
            );
            Ok(Arc::new(Guard {
                stand_in: observing.clone(),
                next: guarded,
            }))
        },
    )
    .unwrap();
    let source = app
        .installer
        .refresh(
            &f.access(f.a),
            Source::Folder(registry_folder.path().into()),
            &key,
            &publisher,
            "calendar-test-registry",
        )
        .unwrap();
    for artifact in artifacts {
        app.installer
            .install(&f.access(f.a), &source, &artifact, true)
            .unwrap();
    }
    let call = |actor: Uuid, method: &str, path: &str, body: Value| -> Value {
        serde_json::from_str(
            &app.dispatch_extended(
                f.access(actor),
                method,
                &format!("/api/m/calendar{path}"),
                &body.to_string(),
            )
            .unwrap(),
        )
        .unwrap()
    };

    // A plan of the owner's own, drafted through the routes with one proposed
    // addition. The pending move belongs to a block the plan placed earlier,
    // so its recorded placement is seeded straight into storage, as the model
    // requires: a draft never writes placements.
    let addition_block = Uuid::new_v4();
    let move_block = Uuid::new_v4();
    let created = call(
        f.a,
        "POST",
        "/day-plans",
        json!({"date":"2026-11-10","timeZone":"UTC"}),
    );
    assert_eq!(created["status"], 200, "{created}");
    let plan = created["body"]["plan"]["id"].as_str().unwrap().to_owned();
    let addition_block: uuid::Uuid = {
        let saved = call(
            f.a,
            "PATCH",
            &format!("/day-plans/{plan}/draft"),
            json!({
                "localDay":"2026-11-10","timeZone":"UTC","expectedRevision":1,
                "blocks": [
                    {"kind": "focus", "title": "Write the chapter",
                     "pendingChange": {"kind":"add","startsAt":"2026-11-10T09:00:00Z","durationMinutes":30}},
                ]
            }),
        );
        assert_eq!(saved["status"], 200, "{saved}");
        saved["body"]["plan"]["blocks"][0]["id"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    };
    f.rt.block_on(async {
        f.root.execute(
            "INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,title,position,actual_placement,pending_change) \
             VALUES($1,$2::uuid,$3,'focus','Recorded block',1,$4,$5)",
            &[&move_block, &plan.parse::<uuid::Uuid>().unwrap(), &f.a,
              &json!({"startsAt":"2026-11-10T11:00:00Z","durationMinutes":30,"calendarEventRef":"jap-owner-move"}),
              &json!({"kind":"move","startsAt":"2026-11-10T14:00:00Z","durationMinutes":30})],
        ).await.unwrap();
    });
    let apply_path = format!("/day-plans/{plan}/apply");
    let operation_path = |operation: &str| {
        format!("/day-plans/{plan}/operations/{operation}")
    };

    // Apply with an explicit selection runs the addition and gates the move.
    let first = call(
        f.a,
        "POST",
        &apply_path,
        json!({"expectedRevision":2,"idempotencyKey":"db-proof-1",
               "selectedBlockIds":[addition_block, move_block]}),
    );
    assert_eq!(first["status"], 202, "{}", first);
    let operation = first["body"]["operationId"].as_str().unwrap().to_owned();
    let approval = first["body"]["approvalId"].as_str().unwrap().to_owned();
    assert_eq!(first["body"]["status"], "confirmation-required");
    assert_eq!(
        first["body"]["changes"].as_array().unwrap().len(),
        2,
        "{}",
        first
    );
    // Nothing executed for the gated batch: zero provider writes so far.
    assert_eq!(stand_in.writes.lock().unwrap().len(), 0);
    let stored: Vec<(String, String)> = f
        .rt
        .block_on(async {
            let rows = f
                .root
                .query(
                    "SELECT status FROM moss_modules.approvals WHERE id=$1 AND owner_user_id=$2",
                    &[&approval, &f.a],
                )
                .await
                .unwrap();
            rows.iter().map(|row| (row.get::<_, String>(0), String::new())).collect()
        });
    assert_eq!(stored.len(), 1, "the approval is stored owner-scoped");
    assert_eq!(stored[0].0, "pending");

    // The stand-in provider holds the block's recorded event, so the move's
    // provenance readback can prove this plan placed it.
    stand_in.events.lock().unwrap().insert(
        "jap-owner-move".into(),
        json!({"start":"2026-11-10T11:00:00Z","end":"2026-11-10T11:30:00Z",
            "provenance":{"jarvisTool":"applyAddition","jarvisActorUserId":f.a.to_string(),
                "jarvisPlanId":plan,"jarvisBlockId":move_block.to_string(),
                "jarvisPlanRevision":"1","jarvisOperationId":"seeded"},
            "attendeeCount":0}),
    );
    // The owner confirms; the addition is created and the move patched.
    let confirmed = call(
        f.a,
        "POST",
        &format!("{}/confirm", operation_path(&operation)),
        json!({"approvalId": approval}),
    );
    assert_eq!(confirmed["status"], 200, "{confirmed}");
    assert_eq!(confirmed["body"]["status"], "completed");
    let kinds: Vec<(&str, &str)> = confirmed["body"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (
            item["outcome"].as_str().unwrap_or_default(),
            item["result"]["calendarMirror"].as_str().unwrap_or_default(),
        ))
        .collect();
    assert_eq!(kinds, vec![("applied", "written"), ("applied", "written")], "{confirmed}");
    let writes = stand_in.writes.lock().unwrap();
    assert_eq!(writes.len(), 2, "one create and one patch: {writes:?}");
    assert!(writes[0].1["provenance"]["jarvisOperationId"] == json!(operation));
    assert_eq!(writes[1].1["eventRef"], "jap-owner-move");
    drop(writes);
    // The approval is confirmed now, and a replayed confirm is refused.
    let replay = call(
        f.a,
        "POST",
        &format!("{}/confirm", operation_path(&operation)),
        json!({"approvalId": approval}),
    );
    assert_eq!(replay["status"], 409, "{replay}");
    assert_eq!(replay["body"]["error"], "day plan apply approval is not available");

    // A replayed idempotency key returns the stored result: the same
    // operation, the same settled outcomes, and no new provider work.
    let replayed = call(
        f.a,
        "POST",
        &apply_path,
        json!({"expectedRevision":2,"idempotencyKey":"db-proof-1",
               "selectedBlockIds":[addition_block, move_block]}),
    );
    assert_eq!(replayed["status"], 202, "{replayed}");
    assert_eq!(replayed["body"]["operationId"], json!(operation));
    assert!(stand_in.writes.lock().unwrap().len() == 2, "a replay executed again");
    let recovered = call(
        f.a,
        "POST",
        &format!("{}/recover", operation_path(&operation)),
        json!({}),
    );
    assert_eq!(recovered["status"], 200, "{recovered}");
    assert_eq!(recovered["body"]["status"], "completed");
    assert!(stand_in.writes.lock().unwrap().len() == 2, "a settled recover executed again");

    // Another account's plan, batch, operation and approval stay invisible.
    let foreign_plan_apply = || {
        call(
            f.b,
            "POST",
            &apply_path,
            json!({"expectedRevision":2,"idempotencyKey":"foreign-1",
                   "selectedBlockIds":[addition_block, move_block]}),
        )["status"]
            .as_u64()
            .unwrap_or(0) as u16
    };
    let foreign_retry = || {
        call(
            f.b,
            "POST",
            &format!("{}/retry", operation_path(&operation)),
            json!({"itemIds":[Uuid::new_v4()]}),
        )["status"]
            .as_u64()
            .unwrap_or(0) as u16
    };
    let foreign_recover = || {
        call(
            f.b,
            "POST",
            &format!("{}/recover", operation_path(&operation)),
            json!({}),
        )["status"]
            .as_u64()
            .unwrap_or(0) as u16
    };
    let foreign_confirm = || {
        call(
            f.b,
            "POST",
            &format!("{}/confirm", operation_path(&operation)),
            json!({"approvalId": approval}),
        )["status"]
            .as_u64()
            .unwrap_or(0) as u16
    };
    let writes_before = stand_in.writes.lock().unwrap().clone();
    assert_eq!(foreign_plan_apply(), 404, "a foreign plan must read as missing");
    assert_eq!(foreign_retry(), 404, "a foreign operation must read as missing");
    assert_eq!(foreign_recover(), 404, "a foreign operation must read as missing");
    assert_eq!(foreign_confirm(), 404, "a foreign operation must read as missing");
    // Nothing of the owner's changed and nothing reached the provider.
    assert_eq!(*stand_in.writes.lock().unwrap(), writes_before);
    let owner_items: Vec<String> = f.rt.block_on(async {
        let rows = f
            .root
            .query(
                "SELECT outcome FROM app.day_plan_operation_items WHERE operation_id=$1",
                &[&operation],
            )
            .await
            .unwrap();
        rows.iter().map(|row| row.get::<_, String>(0)).collect()
    });
    assert_eq!(owner_items, vec!["applied", "applied"]);

    // A foreign approval on the caller's own batch reads as unavailable.
    let other_plan = call(
        f.b,
        "POST",
        "/day-plans",
        json!({"date":"2026-11-10","timeZone":"UTC"}),
    );
    assert_eq!(other_plan["status"], 200, "{other_plan}");
    let other = other_plan["body"]["plan"]["id"].as_str().unwrap().to_owned();
    let other_move_block = Uuid::new_v4();
    f.rt.block_on(async {
        f.root.execute(
            "INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,title,position,actual_placement,pending_change) \
             VALUES($1,$2::uuid,$3,'focus','Second account placed',1,$4,$5)",
            &[&other_move_block, &other.parse::<uuid::Uuid>().unwrap(), &f.b,
              &json!({"startsAt":"2026-11-10T11:00:00Z","durationMinutes":30,"calendarEventRef":"jap-second"}),
              &json!({"kind":"move","startsAt":"2026-11-10T15:00:00Z","durationMinutes":30})],
        ).await.unwrap();
    });
    let other_apply = call(
        f.b,
        "POST",
        &format!("/day-plans/{other}/apply"),
        json!({"expectedRevision":1,"idempotencyKey":"second-1","selectedBlockIds":[other_move_block]}),
    );
    assert_eq!(other_apply["status"], 202, "{other_apply}");
    let second_operation = other_apply["body"]["operationId"].as_str().unwrap().to_owned();
    let foreign_approval = call(
        f.b,
        "POST",
        &format!("/day-plans/{other}/operations/{second_operation}/confirm"),
        json!({"approvalId": approval}),
    );
    assert_eq!(foreign_approval["status"], 409, "{foreign_approval}");
    assert_eq!(
        foreign_approval["body"]["error"],
        "day plan apply approval is not available"
    );
    // The second account's batch executed nothing.
    let second_items: Vec<String> = f.rt.block_on(async {
        let rows = f
            .root
            .query(
                "SELECT outcome FROM app.day_plan_operation_items WHERE operation_id=$1",
                &[&second_operation],
            )
            .await
            .unwrap();
        rows.iter().map(|row| row.get::<_, String>(0)).collect()
    });
    assert_eq!(second_items, vec!["pending"]);
    assert!(stand_in.writes.lock().unwrap().len() == 2, "a refused confirm executed something");

    // RED: with the day-plan row security removed, the same 404 assertions must
    // detect the leak; with the approval row security removed, the foreign
    // approval must stop reading as unavailable.
    f.rt.block_on(async {
        for table in DAY_PLAN_TABLES {
            f.root.execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"), &[])
                .await
                .unwrap();
        }
    });
    let leaked_plan = foreign_plan_apply();
    let leaked_retry = foreign_retry();
    let leaked_recover = foreign_recover();
    let leaked_confirm = foreign_confirm();
    f.rt.block_on(async {
        for table in DAY_PLAN_TABLES {
            f.root
                .execute(
                    &format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY"),
                    &[],
                )
                .await
                .unwrap();
        }
    });
    assert_ne!(leaked_plan, 404, "the apply 404 must detect removed row security");
    assert_ne!(leaked_retry, 404, "the retry 404 must detect removed row security");
    assert_ne!(leaked_recover, 404, "the recover 404 must detect removed row security");
    assert_ne!(leaked_confirm, 404, "the confirm 404 must detect removed row security");
    println!("RED day-plan row security: every foreign 404 detects a removed protection");

    f.rt.block_on(async {
        f.root
            .execute("ALTER TABLE moss_modules.approvals DISABLE ROW LEVEL SECURITY", &[])
            .await
            .unwrap();
    });
    let leaked_approval = call(
        f.b,
        "POST",
        &format!("/day-plans/{other}/operations/{second_operation}/confirm"),
        json!({"approvalId": approval}),
    );
    f.rt.block_on(async {
        f.root
            .execute(
                "ALTER TABLE moss_modules.approvals ENABLE ROW LEVEL SECURITY; ALTER TABLE moss_modules.approvals FORCE ROW LEVEL SECURITY",
                &[],
            )
            .await
            .unwrap();
    });
    assert_eq!(leaked_approval["status"], 409, "{leaked_approval}");
    assert_ne!(
        leaked_approval["body"]["error"],
        "day plan apply approval is not available",
        "the foreign-approval refusal must detect removed row security"
    );
    println!("RED approvals row security: the foreign approval stops reading as unavailable without it");

    // GREEN: with the protections back, every assertion holds again.
    assert_eq!(foreign_plan_apply(), 404);
    assert_eq!(foreign_retry(), 404);
    assert_eq!(foreign_recover(), 404);
    assert_eq!(foreign_confirm(), 404);
    let green = call(
        f.b,
        "POST",
        &format!("/day-plans/{other}/operations/{second_operation}/confirm"),
        json!({"approvalId": approval}),
    );
    assert_eq!(green["status"], 409);
    assert_eq!(green["body"]["error"], "day plan apply approval is not available");
    println!("GREEN row security restored: plans, operations and approvals are owner-scoped again");
    // And the owner's own flow still answers from the stored state.
    let settled = call(
        f.a,
        "GET",
        &operation_path(&operation),
        Value::Null,
    );
    assert_eq!(settled["status"], 200, "{settled}");
    assert_eq!(settled["body"]["status"], "completed");
}
