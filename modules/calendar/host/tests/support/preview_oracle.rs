use crate::support::Fixture;
use moss_module_host::{application::Application, runtime::CallScope};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Write,
    process::{Command, Stdio},
    sync::Arc,
};
use uuid::Uuid;

pub struct Seeded {
    pub task_block: Uuid,
    pub plain_block: Uuid,
    pub done_block: Uuid,
    pub archived_block: Uuid,
    pub due_block: Uuid,
    pub foreign_block: Uuid,
    pub remove_block: Uuid,
    pub tasks: Value,
    pub references: Arc<dyn moss_calendar_host::References>,
}

struct Facts {
    tasks: HashMap<String, Value>,
}
impl moss_calendar_host::References for Facts {
    fn task(&self, _: &CallScope, id: &str) -> anyhow::Result<Value> {
        self.tasks
            .get(id)
            .map(|task| json!({"task": task}))
            .ok_or_else(|| anyhow::anyhow!("task is not available"))
    }
    fn briefing_run(&self, _: &CallScope, _: &str) -> anyhow::Result<Value> {
        anyhow::bail!("briefing run is not available")
    }
}

pub fn seed(f: &Fixture) -> Seeded {
    let ids: Vec<Uuid> = (0..11).map(|_| Uuid::new_v4()).collect();
    let (task_block, plain_block, done_block, archived_block, due_block, foreign_block) =
        (ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]);
    let remove_block = ids[6];
    let (done_task, archived_task, due_task, foreign_task) = (ids[7], ids[8], ids[9], ids[10]);
    let due_at = "2026-11-08T17:30:00.000Z";
    let mut facts = HashMap::new();
    for (id, owner, status, due) in [
        (done_task, f.a, "done", Value::Null),
        (archived_task, f.a, "archived", Value::Null),
        (due_task, f.a, "open", json!(due_at)),
        (foreign_task, f.b, "open", Value::Null),
    ] {
        facts.insert(
            id.to_string(),
            json!({"id":id,"ownerUserId":owner,"status":status,"dueAt":due}),
        );
    }
    let tasks = json!({
        done_task.to_string(): {"ownerUserId": f.a, "status": "done", "dueAt": null},
        archived_task.to_string(): {"ownerUserId": f.a, "status": "archived", "dueAt": null},
        due_task.to_string(): {"ownerUserId": f.a, "status": "open", "dueAt": due_at},
        foreign_task.to_string(): {"ownerUserId": f.b, "status": "open", "dueAt": null},
    });
    f.rt.block_on(async {
        let rows: [(Uuid, Option<Uuid>, &str, &str); 6] = [
            (task_block, Some(f.event), "Task change", "{\"kind\":\"move\",\"startsAt\":\"2026-11-08T12:00:00Z\",\"durationMinutes\":30}"),
            (plain_block, None, "Plain change", "{\"kind\":\"add\",\"startsAt\":\"2026-11-08T12:15:00Z\",\"durationMinutes\":30}"),
            (done_block, Some(done_task), "Done task", "{\"kind\":\"move\",\"startsAt\":\"2026-11-08T14:00:00Z\",\"durationMinutes\":30}"),
            (archived_block, Some(archived_task), "Archived task", "{\"kind\":\"add\",\"startsAt\":\"2026-11-08T15:00:00Z\",\"durationMinutes\":30}"),
            (due_block, Some(due_task), "Due task", "{\"kind\":\"move\",\"startsAt\":\"2026-11-08T17:00:00Z\",\"durationMinutes\":60}"),
            (foreign_block, Some(foreign_task), "Foreign task", "{\"kind\":\"add\",\"startsAt\":\"2026-11-08T19:00:00Z\",\"durationMinutes\":30}"),
        ];
        for (index, (id, task, title, pending)) in rows.into_iter().enumerate() {
            let pending: Value = serde_json::from_str(pending).unwrap();
            f.root.execute(
                "INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,title,position,task_id,pending_change) VALUES($1,$2,$3,'focus',$4,$5,$6,$7)",
                &[&id, &f.plan, &f.a, &title, &(90 + index as i32), &task, &pending],
            )
            .await
            .unwrap();
        }
        f.root.execute(
            "INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,title,position,actual_placement,pending_change) VALUES($1,$2,$3,'focus','Remove change',97,'{\"startsAt\":\"2026-11-08T09:00:00Z\",\"durationMinutes\":45,\"calendarEventRef\":null}','{\"kind\":\"remove\"}')",
            &[&remove_block, &f.plan, &f.a],
        )
        .await
        .unwrap();
    });
    Seeded {
        task_block,
        plain_block,
        done_block,
        archived_block,
        due_block,
        foreign_block,
        remove_block,
        tasks,
        references: Arc::new(Facts { tasks: facts }),
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
    // (url, body, compare the full body and not only the status)
    let cases: Vec<(String, Value, bool)> = vec![
        (
            url.clone(),
            json!({"expectedRevision":1,"selectedChangeBlockIds":[seeded.task_block, seeded.plain_block, seeded.done_block, seeded.archived_block, seeded.due_block, seeded.foreign_block, seeded.remove_block, seeded.task_block]}),
            true,
        ),
        (
            url.clone(),
            json!({"expectedRevision":99,"selectedChangeBlockIds":[seeded.plain_block]}),
            true,
        ),
        (
            url.clone(),
            json!({"expectedRevision":1,"selectedChangeBlockIds":[seeded.plain_block],"extra":1}),
            true,
        ),
        (
            url.clone(),
            json!({"expectedRevision":1,"selectedChangeBlockIds":[f.block]}),
            true,
        ),
        (
            url.clone(),
            json!({"expectedRevision":1,"selectedChangeBlockIds":[missing]}),
            true,
        ),
        (
            url.clone(),
            json!({"expectedRevision":0,"selectedChangeBlockIds":[seeded.plain_block]}),
            false,
        ),
        (
            url.clone(),
            json!({"expectedRevision":1,"selectedChangeBlockIds":["not-a-uuid"]}),
            false,
        ),
        (
            "/day-plans/not-a-uuid/preview".into(),
            json!({"expectedRevision":1,"selectedChangeBlockIds":[seeded.plain_block]}),
            false,
        ),
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
                json!({"actor":actor,"tasks":seeded.tasks,"requests":cases.iter().map(|(path, body, _)| json!({"method":"POST","url":format!("/api/calendar{path}"),"body":body})).collect::<Vec<_>>()})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "Production preview oracle failed (database diagnostics omitted)"
        );
        let mut expected: Vec<Value> = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(
            expected.len(),
            cases.len(),
            "Preview oracle omitted a response"
        );
        for (index, ((path, body, compare_body), expected)) in
            cases.iter().zip(expected.iter_mut()).enumerate()
        {
            let raw = app
                .dispatch_extended(
                    f.access(actor),
                    "POST",
                    &format!("/api/m/calendar{path}"),
                    &body.to_string(),
                )
                .unwrap();
            let actual: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                actual["status"], expected["status"],
                "Installed Wasm preview status differs from production route in case {index}"
            );
            if *compare_body {
                let mut response = json!({"status":actual["status"],"body":actual["body"]});
                javascript_numbers(&mut response);
                javascript_numbers(expected);
                assert_eq!(
                    response, *expected,
                    "Installed Wasm preview differs from production preview in case {index}"
                );
            }
        }
    }
    // Later draft assertions own the plan's block list again.
    let seeded_ids = [
        seeded.task_block,
        seeded.plain_block,
        seeded.done_block,
        seeded.archived_block,
        seeded.due_block,
        seeded.foreign_block,
        seeded.remove_block,
    ];
    f.rt.block_on(async {
        for id in seeded_ids {
            f.root
                .execute("DELETE FROM app.day_plan_blocks WHERE id=$1", &[&id])
                .await
                .unwrap();
        }
    });
    println!("PASS 24 installed-Wasm / production HTTP preview comparisons (owner, foreign, admin; task eligibility, deadline risk, removal, revision and validation cases)");
}
