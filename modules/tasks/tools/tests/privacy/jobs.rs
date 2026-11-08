use super::*;
use moss_module_host::jobs::{specs, JobPorts};
use safety_core::secret::Secret;

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
    let invoke = |actor| {
        f.host.call(
            &f.wasm,
            f.manifest.clone(),
            AccessContext::new(actor, "deferred-worker"),
            f.ports.clone(),
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
