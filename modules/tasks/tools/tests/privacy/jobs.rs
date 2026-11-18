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
    f.rt.block_on(f.db.execute(
        "DELETE FROM app.tasks WHERE id=$1 AND owner_user_id=$2",
        &[&next_id.parse::<Uuid>().unwrap(), &f.owner],
    ))
    .unwrap();
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

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_recurrence_schedule_is_one_per_account_and_job_rolls_only_that_account() {
    let mut f = Fixture::open_with(true);
    // Another test in the same run may have installed the queue schema already.
    let queue_installed: bool = f
        .rt
        .block_on(f.db.query_one(
            "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='moss_queue')",
            &[],
        ))
        .unwrap()
        .get(0);
    if !queue_installed {
        f.sql(moss_platform_jobs::MIGRATION);
    }
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
    // Enabling recurrence on an existing task must register the schedule too.
    let plain = f.route(f.other, "POST", "/tasks", json!({"title":"Plain task"}));
    let plain_id = plain["body"]["task"]["id"].as_str().unwrap().to_string();
    let count = |actor: Uuid| -> i64 {
        f.rt.block_on(f.db.query_one(
            "SELECT count(*) FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue LIKE '%.tasks-recurrence'",
            &[&actor],
        ))
        .unwrap()
        .get(0)
    };
    assert_eq!(count(f.other), 0);
    let patched = f.route(
        f.other,
        "PATCH",
        &format!("/tasks/{plain_id}"),
        json!({"recurrence":{"freq":"daily","interval":1,"occurrence_date":"2099-01-01"}}),
    );
    assert_eq!(patched["status"], 200);
    assert_eq!(count(f.other), 1, "enabling recurrence by update must schedule the job");
    let make = |actor, title: &str| {
        let created = f.route(
            actor,
            "POST",
            "/tasks",
            json!({"title":title,"recurrence":{"freq":"daily","interval":1,"occurrence_date":"2020-01-01"}}),
        );
        assert_eq!(created["status"], 201);
        created["body"]["task"]["id"].as_str().unwrap().to_string()
    };
    let owner_task = make(f.owner, "Owner series");
    let other_task = make(f.other, "Other series");
    // A second recurring create must replace, not add to, the account's schedule.
    make(f.owner, "Owner second series");
    let schedules = |actor: Uuid| -> i64 {
        f.rt.block_on(f.db.query_one(
            "SELECT count(*) FROM moss_queue.schedules WHERE actor_user_id=$1 AND queue LIKE '%.tasks-recurrence'",
            &[&actor],
        ))
        .unwrap()
        .get(0)
    };
    assert_eq!(schedules(f.owner), 1);
    assert_eq!(schedules(f.other), 1);
    let occurrence = |id: &str| -> String {
        f.rt.block_on(f.db.query_one(
            "SELECT recurrence->>'occurrence_date' FROM app.tasks WHERE id=$1",
            &[&id.parse::<Uuid>().unwrap()],
        ))
        .unwrap()
        .get(0)
    };
    assert_eq!(occurrence(&owner_task), "2020-01-01");
    // Fire the owner's schedule through the real scheduler and worker queue.
    f.rt.block_on(f.db.execute(
        "UPDATE moss_queue.schedules SET next_at=clock_timestamp()-interval '1 minute' WHERE actor_user_id=$1",
        &[&f.owner],
    ))
    .unwrap();
    let job = f.rt.block_on(async {
        let queue = moss_platform_jobs::Queue::connect(
            &std::env::var("JS51_WORKER_URL").unwrap(),
            moss_platform_jobs::Role::Worker,
            specs(&f.manifest),
        )
        .await
        .unwrap();
        assert_eq!(queue.tick().await.unwrap(), 1);
        let job = queue.claim().await.unwrap().expect("recurrence job available");
        (queue, job)
    });
    assert_eq!(job.1.actor.user_id(), f.owner);
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
    let request = json!({"queue":"tasks-recurrence","parameters":job.1.metadata.params().cloned().unwrap_or_else(|| json!({}))});
    let output: Value = serde_json::from_str(
        &f.host
            .call(
                &f.wasm,
                f.manifest.clone(),
                AccessContext::new(job.1.actor.user_id(), "recurrence-worker"),
                job_ports,
                "job",
                &request.to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(output, json!({"rolledForward":2}));
    f.rt.block_on(job.0.finish(&job.1, true)).unwrap();
    assert!(occurrence(&owner_task).as_str() > "2026-01-01");
    assert_eq!(occurrence(&other_task), "2020-01-01", "another account's series stays put");
    println!("PASS recurrence job: one schedule per account, owner series rolled, other untouched");
}
