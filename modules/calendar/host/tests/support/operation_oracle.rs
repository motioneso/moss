use crate::support::Fixture;
use moss_module_host::application::Application;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
use uuid::Uuid;

fn installed(app: &Application, f: &Fixture, actor: Uuid, path: &str) -> Value {
    let raw = app
        .dispatch_extended(
            f.access(actor),
            "GET",
            &format!("/api/m/calendar{path}"),
            "null",
        )
        .unwrap();
    let response: Value = serde_json::from_str(&raw).unwrap();
    json!({"status":response["status"],"body":response["body"]})
}
fn production(actor: Uuid, paths: &[String]) -> Vec<Value> {
    let mut child = Command::new("pnpm")
        .args(["exec", "tsx", "modules/calendar/tools/read-oracle.ts"])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(json!({"actor":actor,"paths":paths.iter().map(|p|format!("/api/calendar{p}")).collect::<Vec<_>>()} ).to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "production operation oracle failed (database diagnostics omitted)"
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn numeric(value: &mut Value) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::Array(items) => items.iter_mut().for_each(numeric),
        Value::Object(items) => items.values_mut().for_each(numeric),
        _ => {}
    }
}

pub fn verify(app: &Application, f: &Fixture) {
    let block = Uuid::new_v4();
    let item = Uuid::new_v4();
    let path = format!("/day-plans/{}/operations/{}", f.plan, f.operation);
    let missing = Uuid::new_v4();
    let paths = vec![
        path.clone(),
        format!("/day-plans/{missing}/operations/{}", f.operation),
        format!("/day-plans/{}/operations/{missing}", f.plan),
        format!("/day-plans/bad/operations/{}", f.operation),
        format!("/day-plans/{}/operations/bad", f.plan),
    ];
    let first = json!({"blockId":f.block,"kind":"remove","startsAt":null,"durationMinutes":null});
    let second = json!({"blockId":block,"kind":"add","startsAt":"2030-05-21T09:00:00Z","durationMinutes":30});
    f.rt.block_on(async {
        f.root.execute("INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,position) VALUES($1,$2,$3,'focus',100)",&[&block,&f.plan,&f.a]).await.unwrap();
        f.root.execute("UPDATE app.day_plan_operation_items SET pending_change=$2 WHERE id=$1",&[&f.item,&first]).await.unwrap();
        f.root.execute("INSERT INTO app.day_plan_operation_items(id,operation_id,plan_id,owner_user_id,block_id,kind,pending_change) VALUES($1,$2,$3,$4,$5,'add',$6)",&[&item,&f.operation,&f.plan,&f.a,&block,&second]).await.unwrap();
    });
    let mut comparisons = 0;
    for (outcome, result) in [
        ("pending", Value::Null),
        ("unknown", json!({"status":"unknown","reason":"unknown"})),
        (
            "failed",
            json!({"status":"failed","reason":"access-denied"}),
        ),
        (
            "failed",
            json!({"status":"failed","reason":"access-denied","internalDetail":"must not return"}),
        ),
        (
            "failed",
            json!({"status":"failed","reason":"provider-rejected","providerEventId":"external-event"}),
        ),
        (
            "applied",
            json!({"status":"applied","removed":true,"providerEventId":"external-event","startsAt":null,"durationMinutes":null,"calendarMirror":"evicted","blockMirror":"mirrored"}),
        ),
        (
            "applied",
            json!({"status":"applied","providerEventId":"external-event","startsAt":"2030-05-21T09:00:00Z","durationMinutes":30,"calendarMirror":"written","blockMirror":"mismatch-preserved"}),
        ),
    ] {
        for snapshot in [
            json!([second, first]),
            json!({"intent":[],"selection":[second,first]}),
        ] {
            f.rt.block_on(async {
                f.root.execute("UPDATE app.day_plan_operations SET selection_snapshot=$2 WHERE id=$1",&[&f.operation,&snapshot]).await.unwrap();
                f.root.execute("UPDATE app.day_plan_operation_items SET outcome=$2,result=$3 WHERE operation_id=$1",&[&f.operation,&outcome,&result]).await.unwrap();
            });
            for actor in [f.a, f.b, f.admin] {
                let expected = production(actor, &paths);
                assert_eq!(expected.len(), paths.len());
                for (path, mut expected) in paths.iter().zip(expected) {
                    let mut actual = installed(app, f, actor, path);
                    assert_eq!(
                        actual["status"], expected["status"],
                        "operation status at {path}"
                    );
                    // Fastify validation and response-serialization bodies are framework-owned.
                    if expected["status"] != 400 && expected["status"] != 500 {
                        numeric(&mut actual);
                        numeric(&mut expected);
                        assert_eq!(actual, expected, "operation response at {path}");
                    }
                    comparisons += 1;
                }
            }
        }
    }
    // The exact installed foreign read must detect removed protection, then
    // return to hidden after restoration. Mutation checks for all five tables
    // remain in privacy.rs and also run in the full gate.
    assert_eq!(installed(app, f, f.b, &path)["status"], 404);
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.day_plan_operations DISABLE ROW LEVEL SECURITY; ALTER TABLE app.day_plan_operation_items DISABLE ROW LEVEL SECURITY")).unwrap();
    let unprotected = installed(app, f, f.b, &path);
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.day_plan_operations ENABLE ROW LEVEL SECURITY; ALTER TABLE app.day_plan_operations FORCE ROW LEVEL SECURITY; ALTER TABLE app.day_plan_operation_items ENABLE ROW LEVEL SECURITY; ALTER TABLE app.day_plan_operation_items FORCE ROW LEVEL SECURITY")).unwrap();
    assert_eq!(
        unprotected["status"], 200,
        "fault witness must expose the operation when policies are disabled"
    );
    assert_eq!(installed(app, f, f.b, &path)["status"], 404);
    assert_eq!(installed(app, f, f.admin, &path)["status"], 404);
    println!("RED/GREEN installed operation privacy: foreign read sees saved status without RLS and is hidden after restoration");
    println!(
        "PASS {comparisons} installed operation HTTP comparisons (framework 400/500 bodies excluded)"
    );
}
