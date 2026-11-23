use crate::support::Fixture;
use moss_module_host::application::Application;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Write,
    process::{Command, Stdio},
};
use uuid::Uuid;

// JSON consumers use one numeric type. Compare 0 and 0.0 equally while retaining
// full object/array contents and order for the remaining numeric fields.
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

// The new safety contract preserves unknown guest counts instead of legacy zero defaults.
// Assert that field against the saved metadata independently; retain full parity for every other field.
fn check_counts(value: &mut Value, counts: Option<&BTreeMap<String, Value>>) {
    match value {
        Value::Object(fields) => {
            if fields.contains_key("startsAt") && fields.contains_key("endsAt") {
                if let Some(counts) = counts {
                    let id = fields["id"].as_str().unwrap();
                    assert_eq!(fields.get("attendeeCount"), Some(&counts[id]), "Saved guest count for {id}");
                }
                fields.remove("attendeeCount");
            }
            fields.values_mut().for_each(|v| check_counts(v, counts));
        }
        Value::Array(values) => values.iter_mut().for_each(|v| check_counts(v, counts)),
        _ => {}
    }
}

pub fn compare(app: &Application, f: &Fixture) {
    let counts: BTreeMap<String, Value> = f.rt.block_on(async {
        f.root.query("SELECT id,external_metadata FROM app.calendar_events", &[]).await.unwrap()
            .into_iter().map(|row| {
                let id: Uuid = row.get(0);
                let metadata: Value = row.get(1);
                (id.to_string(), metadata["attendeeCount"].as_u64().map_or(Value::Null, Value::from))
            }).collect()
    });
    let paths = [
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
            check_counts(&mut response, Some(&counts));
            check_counts(&mut expected, None);
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
