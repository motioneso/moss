use crate::support::Fixture;
use moss_module_host::application::Application;
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
};
use uuid::Uuid;

pub struct Seeded {
    pub task_block: Uuid,
    pub plain_block: Uuid,
}

pub fn seed(f: &Fixture) -> Seeded {
    let task_block = Uuid::new_v4();
    let plain_block = Uuid::new_v4();
    f.rt.block_on(async {
        f.root.execute(
            "INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,title,position,task_id,pending_change) VALUES($1,$2,$3,'focus','Task change',90,$4,'{\"kind\":\"move\",\"startsAt\":\"2026-11-08T12:00:00Z\",\"durationMinutes\":30}')",
            &[&task_block, &f.plan, &f.a, &f.event],
        )
        .await
        .unwrap();
        f.root.execute(
            "INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,title,position,pending_change) VALUES($1,$2,$3,'focus','Plain change',91,'{\"kind\":\"add\",\"startsAt\":\"2026-11-08T12:15:00Z\",\"durationMinutes\":30}')",
            &[&plain_block, &f.plan, &f.a],
        )
        .await
        .unwrap();
    });
    Seeded {
        task_block,
        plain_block,
    }
}

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

pub fn compare(app: &Application, f: &Fixture, seeded: &Seeded) {
    let url = format!("/day-plans/{}/preview", f.plan);
    let missing = Uuid::new_v4();
    let cases: Vec<Value> = vec![
        json!({"expectedRevision":1,"selectedChangeBlockIds":[seeded.task_block, seeded.plain_block, seeded.task_block]}),
        json!({"expectedRevision":99,"selectedChangeBlockIds":[seeded.plain_block]}),
        json!({"expectedRevision":1,"selectedChangeBlockIds":[seeded.plain_block],"extra":1}),
        json!({"expectedRevision":1,"selectedChangeBlockIds":[f.block]}),
        json!({"expectedRevision":1,"selectedChangeBlockIds":[missing]}),
        json!({"expectedRevision":0,"selectedChangeBlockIds":[seeded.plain_block]}),
    ];
    for actor in [f.a, f.b, f.admin] {
        let mut child = Command::new("pnpm")
            .args(["exec", "tsx", "modules/calendar/tools/preview-oracle.ts"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                json!({"actor":actor,"requests":cases.iter().map(|body| json!({"method":"POST","url":format!("/api/calendar{url}"),"body":body})).collect::<Vec<_>>()})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "Production preview oracle failed (database diagnostics omitted)"
        );
        let expected: Vec<Value> = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(expected.len(), cases.len(), "Preview oracle omitted a response");
        for (index, (body, mut expected)) in cases.iter().zip(expected.iter_mut()).enumerate() {
            let raw = app
                .dispatch_extended(
                    f.access(actor),
                    "POST",
                    &format!("/api/m/calendar{url}"),
                    &body.to_string(),
                )
                .unwrap();
            let actual: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                actual["status"], expected["status"],
                "Installed Wasm preview status differs from production route in case {index}"
            );
            if expected["status"] == 200 {
                let mut response = json!({"status":actual["status"],"body":actual["body"]});
                javascript_numbers(&mut response);
                javascript_numbers(&mut expected);
                assert_eq!(
                    response, *expected,
                    "Installed Wasm preview differs from production preview in case {index}"
                );
            }
        }
    }
    println!("PASS 18 installed-Wasm / production HTTP preview comparisons (owner, foreign, admin; status on all cases, body on success)");
}
