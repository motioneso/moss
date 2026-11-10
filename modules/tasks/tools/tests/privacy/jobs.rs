use super::*;
use moss_module_host::jobs::{specs, JobPorts};
use safety_core::secret::Secret;

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_recurring_completion_retry_preserves_history_and_list_order() {
    let f = Fixture::open_with(true);
    let task = f.route(
        f.owner,
        "POST",
        "/tasks",
        json!({
            "title":"Repeat completion history", "dueAt":"2099-05-01T15:30:00.000Z",
            "recurrence":{"freq":"monthly","interval":1,"occurrence_date":"2099-05-01"}
        }),
    );
    assert_eq!(task["status"], 201);
    let id = task["body"]["task"]["id"].as_str().unwrap();
    let request = json!({"queue":"tasks-deferred-status","parameters":{
        "task-id":id,"requested-status":"done"
    }})
    .to_string();
    let invoke = || {
        let output = f
            .host
            .call(
                &f.wasm,
                f.manifest.clone(),
                AccessContext::new(f.owner, "repeat-completion"),
                f.ports.clone(),
                "job",
                &request,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&output).unwrap(),
            json!({"taskId":id,"updated":true,"status":"done"})
        );
    };
    invoke();
    let path = format!("/tasks/{id}");
    let completed = f.route(f.owner, "GET", &path, Value::Null);
    // Ensure a rewritten timestamp cannot happen to compare equal within one millisecond.
    std::thread::sleep(std::time::Duration::from_millis(10));
    invoke();
    assert_eq!(
        f.route(f.owner, "GET", &path, Value::Null),
        completed,
        "a repeated recurring completion must retain the completed history"
    );
    let tasks = f.route(f.owner, "GET", "/tasks", Value::Null);
    let items = tasks["body"]["tasks"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["source"], "recurrence");
    assert_eq!(items[0]["recurrence"]["occurrence_date"], "2099-06-01");
    assert_eq!(items[1]["id"], id);
    let retry = f.route(f.owner, "PATCH", &path, json!({"status":"done"}));
    assert_eq!(retry, completed);
    let retry = f
        .tool(
            f.owner,
            "tasks.updateStatus",
            json!({"taskId":id,"status":"done"}),
        )
        .unwrap();
    assert_eq!(retry["data"]["task"], completed["body"]["task"]);

    // A completed series whose successor was deleted still needs the legacy repair.
    let next_id = items[0]["id"].as_str().unwrap();
    assert_eq!(
        f.route(f.owner, "DELETE", &format!("/tasks/{next_id}"), Value::Null)["status"],
        200
    );
    invoke();
    let repaired = f.route(f.owner, "GET", "/tasks", Value::Null);
    let repaired = repaired["body"]["tasks"].as_array().unwrap();
    assert_eq!(repaired.len(), 2);
    assert_eq!(
        repaired
            .iter()
            .filter(|t| t["recurrence"]["occurrence_date"] == "2099-06-01")
            .count(),
        1
    );
    let edited = f.route(
        f.owner,
        "PATCH",
        &path,
        json!({"title":"Edited completed task"}),
    );
    assert_eq!(edited["status"], 200);
    assert_eq!(
        f.route(f.owner, "GET", &path, Value::Null)["body"]["task"]["title"],
        "Edited completed task"
    );
    println!(
        "PASS repeat completion: exact completed history, one successor, next occurrence first"
    );
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_deferred_status_uses_real_queue_and_captured_actor() {
    let mut f = Fixture::open_with(true);
    f.sql(moss_platform_jobs::MIGRATION);
    let app_url = std::env::var("JS51_APP_URL").unwrap();
    let app =
        f.rt.block_on(Database::connect(&app_url, 4, RuntimeRole::App))
            .unwrap();
    f.ports = Arc::new(ContextPorts::new(Arc::new(
        TransactionalDatabasePorts::new(
            app.clone(),
            Arc::new(JobPorts::new(Secret::new(app_url), app, Arc::new(DenyPorts)).unwrap()),
        )
        .unwrap(),
    )));
    let task = f.route(
        f.owner,
        "POST",
        "/tasks",
        json!({"title":"Queued private task"}),
    );
    let id = task["body"]["task"]["id"].as_str().unwrap();
    let path = format!("/tasks/{id}/deferred-status");
    for actor in [f.other, f.admin] {
        assert_eq!(
            f.route(actor, "POST", &path, json!({"status":"done"}))["status"],
            404
        );
    }
    assert_eq!(
        f.route(f.owner, "POST", &path, json!({"status":"wrong"}))["status"],
        400
    );
    let response = f.route(
        f.owner,
        "POST",
        &path,
        json!({"status":"done","actorUserId":f.other}),
    );
    assert_eq!(response["status"], 202);
    let job = f.rt.block_on(async {
        let queue = moss_platform_jobs::Queue::connect(
            &std::env::var("JS51_WORKER_URL").unwrap(),
            moss_platform_jobs::Role::Worker,
            specs(&f.manifest),
        )
        .await
        .unwrap();
        let job = queue
            .claim()
            .await
            .unwrap()
            .expect("deferred task job available");
        assert_eq!(job.actor.user_id(), f.owner);
        assert_eq!(
            job.metadata.params().unwrap(),
            &json!({"task-id":id,"requested-status":"done"})
        );
        (queue, job)
    });
    let request =
        json!({"queue":"tasks-deferred-status","parameters":job.1.metadata.params().unwrap()});
    // Execute resource reads and writes under the actual worker database role,
    // independently of the request producer's app-role connection pool.
    let worker =
        f.rt.block_on(Database::connect(
            &std::env::var("JS51_WORKER_URL").unwrap(),
            4,
            RuntimeRole::Worker,
        ))
        .unwrap();
    let job_ports = Arc::new(ContextPorts::new(Arc::new(
        TransactionalDatabasePorts::new(worker, Arc::new(DenyPorts)).unwrap(),
    )));
    let invoke = |actor| {
        f.host.call(
            &f.wasm,
            f.manifest.clone(),
            AccessContext::new(actor, "deferred-worker"),
            job_ports.clone(),
            "job",
            &request.to_string(),
        )
    };
    let result: Value = serde_json::from_str(&invoke(job.1.actor.user_id()).unwrap()).unwrap();
    assert_eq!(result, json!({"taskId":id,"updated":true,"status":"done"}));
    assert_eq!(
        f.route(f.owner, "GET", &format!("/tasks/{id}"), Value::Null)["body"]["task"]["status"],
        "done"
    );
    f.rt.block_on(job.0.finish(&job.1, true)).unwrap();
    // The exact worker assertion fails with RLS removed and passes after restoration.
    for removed in [false, true, false] {
        f.sql(if removed {"ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY"} else {"ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY"});
        let output: Value = serde_json::from_str(&invoke(f.other).unwrap()).unwrap();
        if removed {
            assert_eq!(output, json!({"taskId":id,"updated":true,"status":"done"}));
        }
        let assert_private = || {
            assert_eq!(
                output,
                json!({"taskId":id,"updated":false,"status":null}),
                "another account's worker must not change a private task"
            );
        };
        if removed {
            assert!(
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(assert_private)).is_err()
            );
        } else {
            assert_private();
        }
        println!("PASS deferred-worker privacy assertion: RLS removed={removed}");
    }
}
