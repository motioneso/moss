use crate::support::Fixture;
use moss_module_host::application::Application;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
use uuid::Uuid;

// JSON consumers use one numeric type. Compare 0 and 0.0 equally while retaining
// full object/array contents and order; the guest serializer emits f64 metadata.
fn javascript_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            *number = serde_json::Number::from_f64(number.as_f64().unwrap()).unwrap();
        }
        Value::Array(values) => values.iter_mut().for_each(javascript_numbers),
        Value::Object(values) => values.values_mut().for_each(javascript_numbers),
        _ => {}
    }
}

pub fn seed(f: &Fixture) {
    f.rt.block_on(async {
        for (index, metadata) in [
            json!({"allDay":true}),
            json!({"status":"tentative","attendeeCount":1}),
            json!({"source":"outlook-browser-calendar","mirrorUnconfirmed":true}),
            json!({"jarvisCreated":true,"attendeeCount":2}),
        ].into_iter().enumerate() {
            assert_eq!(f.root.execute(
                "INSERT INTO app.calendar_events(id,connector_account_id,owner_user_id,title,starts_at,ends_at,external_id,external_metadata) SELECT gen_random_uuid(),connector_account_id,owner_user_id,$2,starts_at,ends_at,$3,$4 FROM app.calendar_events WHERE id=$1",
                &[&f.event, &format!("HTTP parity {index}"), &format!("http-{}-{index}",f.event), &metadata],
            ).await.unwrap(), 1);
        }
    });
}

pub fn compare(app: &Application, f: &Fixture) {
    let paths = vec![
        "/events".to_string(),
        format!("/events/{}", f.event),
        format!("/events/{}", Uuid::new_v4()),
        "/briefing-settings".to_string(),
    ];
    for actor in [f.a, f.b, f.admin] {
        let mut child = Command::new("pnpm")
            .args(["exec", "tsx", "modules/calendar/tools/read-oracle.ts"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(json!({
            "actor":actor,"paths":paths.iter().map(|p|format!("/api/calendar{p}")).collect::<Vec<_>>()
        }).to_string().as_bytes()).unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "Production HTTP oracle failed (database diagnostics omitted)"
        );
        let expected: Vec<Value> = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(
            expected.len(),
            paths.len(),
            "Read oracle omitted a response"
        );
        for (path, mut expected) in paths.iter().zip(expected) {
            let raw = app
                .dispatch_extended(
                    f.access(actor),
                    "GET",
                    &format!("/api/m/calendar{path}"),
                    "null",
                )
                .unwrap();
            let actual: Value = serde_json::from_str(&raw).unwrap();
            let mut response = json!({"status":actual["status"],"body":actual["body"]});
            javascript_numbers(&mut response);
            javascript_numbers(&mut expected);
            assert_eq!(
                response, expected,
                "Installed Wasm differs from production HTTP route at {path}"
            );
        }
    }
    println!("PASS 12 installed-Wasm / production HTTP read comparisons (owner, foreign, admin)");
}
