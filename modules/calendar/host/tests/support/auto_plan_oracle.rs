//! Unattended day-plan step against the installed Wasm, real Postgres and row security.
use crate::support::Fixture;
use moss_module_host::application::Application;
use serde_json::{json, Value};
use uuid::Uuid;

const DAY: &str = "2031-03-04";

fn api(app: &Application, f: &Fixture, actor: Uuid, name: &str, parameters: Value) -> Value {
    let text = app
        .installer
        .call("calendar", f.access(actor), "api", &json!({"name":name,"parameters":parameters}).to_string())
        .unwrap();
    serde_json::from_str(&text).unwrap()
}
fn signal(target: &str) -> Value {
    json!({"type":"prep_needed","summary":"Prep for review","suggestedActions":[],
        "followThrough":{"targetRef":target,"intents":[{"kind":"block_time","targetRef":target,"title":"t",
        "window":{"start":"2031-03-04T09:00:00.000Z","end":"2031-03-04T09:30:00.000Z","durationMinutes":30}}]}})
}
fn run(run_id: &str, signals: Value) -> Value {
    json!({"runId":run_id,"definitionId":"live-definition","localDay":DAY,"timeZone":"UTC","signals":signals})
}

pub fn verify(app: &Application, f: &Fixture) {
    let created = api(app, f, f.a, "createPlan", json!({"localDay":DAY,"timeZone":"UTC"}));
    let plan_id = created["plan"]["id"].as_str().unwrap().to_owned();
    // One real cached event carries the follow-through reference of the second block.
    f.rt.block_on(async {
        f.root.execute(
            "INSERT INTO app.calendar_events(id,connector_account_id,owner_user_id,title,starts_at,ends_at,external_id,external_metadata) \
             SELECT gen_random_uuid(),connector_account_id,owner_user_id,'Legacy block','2031-03-04T11:00:00Z','2031-03-04T11:45:00Z','legacy-ext-1',$2 FROM app.calendar_events WHERE id=$1",
            &[&f.event, &json!({"jarvisCreated":true,"followThroughTargetRef":"live-ref-b"})],
        ).await.unwrap();
    });
    let signals = json!([signal("live-ref-a"), signal("live-ref-b")]);
    let out = api(app, f, f.a, "reserveAutoPlan", run("live-run-1", signals.clone()));
    let result = &out["reservation"];
    assert_eq!(result["planId"], plan_id, "{out}");
    assert_eq!(result["autoBlockIds"].as_array().unwrap().len(), 1, "{out}");
    assert_eq!(result["batchKey"], "day-plan-auto:live-run-1");
    assert_eq!(result["revisionRace"], false);
    let operation = result["operationId"].as_str().unwrap().to_owned();
    let (blocks, items, revision) = f.rt.block_on(async {
        let blocks = f.root.query("SELECT id::text, pending_change, actual_placement FROM app.day_plan_blocks WHERE plan_id=$1::text::uuid ORDER BY position", &[&plan_id]).await.unwrap();
        let items = f.root.query("SELECT block_id::text FROM app.day_plan_operation_items WHERE operation_id=$1::text::uuid", &[&operation]).await.unwrap();
        let revision: i32 = f.root.query_one("SELECT revision FROM app.day_plans WHERE id=$1::text::uuid", &[&plan_id]).await.unwrap().get(0);
        (blocks, items, revision)
    });
    assert_eq!(blocks.len(), 2);
    assert_eq!(revision, 2);
    // Only the pending block is frozen; the linked one is recorded as already placed.
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].get::<_, String>(0), result["autoBlockIds"][0].as_str().unwrap());
    let placed: Vec<_> = blocks.iter().filter(|b| b.get::<_, Option<Value>>(2).is_some()).collect();
    assert_eq!(placed.len(), 1);
    let placement: Value = placed[0].get(2);
    assert_eq!(placement["calendarEventRef"], "legacy-ext-1");
    assert_eq!(placement["durationMinutes"].as_f64(), Some(45.0));
    // The batch is unfinished until the apply job settles its items.
    let unfinished = api(app, f, f.a, "findUnfinishedBatch", json!({"planId":plan_id,"batchKey":"day-plan-auto:live-run-1"}));
    assert_eq!(unfinished["operationId"], operation.as_str());
    // A duplicate scheduled fire converges: no new blocks, no second batch.
    let again = api(app, f, f.a, "reserveAutoPlan", run("live-run-1", signals));
    assert_eq!(again["reservation"]["autoBlockIds"], json!([]));
    assert!(again["reservation"]["operationId"].is_null());
    let (block_count, batch_count): (i64, i64) = f.rt.block_on(async {
        (
            f.root.query_one("SELECT count(*) FROM app.day_plan_blocks WHERE plan_id=$1::text::uuid", &[&plan_id]).await.unwrap().get(0),
            f.root.query_one("SELECT count(*) FROM app.day_plan_operations WHERE plan_id=$1::text::uuid", &[&plan_id]).await.unwrap().get(0),
        )
    });
    assert_eq!((block_count, batch_count), (2, 1));
    // Another account never sees the plan or its batch.
    let foreign = api(app, f, f.b, "findUnfinishedBatch", json!({"planId":plan_id,"batchKey":"day-plan-auto:live-run-1"}));
    assert!(foreign["operationId"].is_null(), "{foreign}");
    println!("PASS auto-plan step on installed Wasm: block reserved, linked block recorded, duplicate fire converged, foreign account sees nothing");
}
