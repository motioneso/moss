use super::*;

fn create_list(f: &Fixture, actor: Uuid, name: &str) -> String {
    let response = f.route(actor, "POST", "/tasks/lists", json!({"name":name}));
    assert_eq!(response["status"], 201);
    response["body"]["list"]["id"].as_str().unwrap().into()
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_list_deletion_preserves_tasks_and_requires_rls() {
    let f = Fixture::open_with(true);
    let source = create_list(&f, f.owner, "Source");
    let destination = create_list(&f, f.owner, "Destination");
    f.seed_task(&source);
    let path = format!("/tasks/lists/{source}");
    assert_eq!(f.route(f.owner, "DELETE", &path, json!({}))["status"], 409);
    assert_eq!(
        f.route(f.owner, "DELETE", &path, Value::Null)["status"],
        409
    );
    assert_eq!(
        f.route(f.owner, "DELETE", &path, json!({"reassignToListId":source}))["status"],
        400
    );
    let tag = f.route(
        f.owner,
        "POST",
        &format!("{path}/tags"),
        json!({"name":"Source tag"}),
    );
    let tag = tag["body"]["tag"]["id"].as_str().unwrap();
    assert_eq!(
        f.route(
            f.owner,
            "POST",
            &format!("/tasks/{}/tags", f.task),
            json!({"tagId":tag})
        )["status"],
        200
    );
    for actor in [f.other, f.admin] {
        create_list(&f, actor, "First");
        create_list(&f, actor, "Second");
        let denied = f.route(actor, "DELETE", &path, json!({}));
        assert_eq!(denied["status"], 404);
        assert!(f
            .tool(actor, "tasks.deleteList", json!({"listId":source}))
            .is_err());
    }
    let read_destination = || -> Value {
        f.rt.block_on(f.db.query_one(
            "SELECT to_jsonb(l) FROM app.task_lists l WHERE id=$1",
            &[&Uuid::parse_str(&destination).unwrap()],
        ))
        .unwrap()
        .get(0)
    };
    let destination_before = read_destination();
    let moved = f.route(
        f.owner,
        "DELETE",
        &path,
        json!({"reassignToListId":destination}),
    );
    assert_eq!(moved["status"], 200);
    assert_eq!(moved["body"], json!({"deleted":true}));
    assert_eq!(
        read_destination(),
        destination_before,
        "Successful deletion preserves the entire surviving list record"
    );
    let kept = f.route(f.owner, "GET", &format!("/tasks/{}", f.task), Value::Null);
    assert_eq!(kept["body"]["task"]["listId"], destination);
    assert_eq!(kept["body"]["task"]["tags"], json!([]));
    assert_eq!(
        f.route(
            f.owner,
            "DELETE",
            &format!("/tasks/lists/{destination}"),
            json!({})
        )["body"]["error"],
        "Cannot delete your only list"
    );
    // Scope removal probes to one synthetic list ID. Owned count/lock reads stay
    // bounded to the caller's own lists even with the list policy removed.
    for actor in [f.other, f.admin] {
        let id = create_list(&f, f.owner, &format!("Private {actor}"));
        let path = format!("/tasks/lists/{id}");
        let assert_private = |response: &Value| {
            assert_eq!(
                response["status"], 404,
                "Another account cannot delete a private list"
            )
        };
        assert_private(&f.route(actor, "DELETE", &path, json!({})));
        f.sql("ALTER TABLE app.task_lists DISABLE ROW LEVEL SECURITY");
        let removed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            f.route(actor, "DELETE", &path, json!({}))
        }));
        f.sql("ALTER TABLE app.task_lists ENABLE ROW LEVEL SECURITY; ALTER TABLE app.task_lists FORCE ROW LEVEL SECURITY");
        let exposed = removed.expect("Removed-policy call must complete");
        assert_eq!(exposed["status"], 200);
        assert_eq!(exposed["body"], json!({"deleted":true}));
        assert!(std::panic::catch_unwind(|| assert_private(&exposed)).is_err());
        let id = create_list(&f, f.owner, &format!("Restored {actor}"));
        assert_private(&f.route(actor, "DELETE", &format!("/tasks/lists/{id}"), json!({})));
        let tool_id = create_list(&f, f.owner, &format!("Tool private {actor}"));
        let assert_tool_private = |result: &Result<Value>| {
            assert!(
                result.is_err(),
                "Another account cannot delete a private list through a tool"
            )
        };
        assert_tool_private(&f.tool(actor, "tasks.deleteList", json!({"listId":tool_id})));
        f.sql("ALTER TABLE app.task_lists DISABLE ROW LEVEL SECURITY");
        let removed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            f.tool(actor, "tasks.deleteList", json!({"listId":tool_id}))
        }));
        f.sql("ALTER TABLE app.task_lists ENABLE ROW LEVEL SECURITY; ALTER TABLE app.task_lists FORCE ROW LEVEL SECURITY");
        let exposed = removed.expect("Removed-policy tool must complete");
        assert_eq!(
            exposed.as_ref().unwrap(),
            &json!({"data":{"summary":"Deleted task list.","deleted":true}})
        );
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| assert_tool_private(
                &exposed
            )))
            .is_err()
        );
        let tool_id = create_list(&f, f.owner, &format!("Tool restored {actor}"));
        assert_tool_private(&f.tool(actor, "tasks.deleteList", json!({"listId":tool_id})));
    }
    println!("PASS compiled list deletion: private/admin removal controls fail without RLS and pass restored; reassignment keeps tasks and drops tags");
}

struct FailListMove(Arc<dyn Ports>);
impl Ports for FailListMove {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port == "db" && r.resource == "app.tasks" && r.parameters["kind"] == "update" {
            anyhow::bail!("Injected failure after assignment removal");
        }
        self.0.invoke(scope, port, r)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.0.finish_call(scope, success)
    }
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_list_move_failure_rolls_back_assignment_removal() {
    let mut f = Fixture::open_with(true);
    let source = create_list(&f, f.owner, "Rollback source");
    let destination = create_list(&f, f.owner, "Rollback destination");
    f.seed_task(&source);
    let tag = f.route(
        f.owner,
        "POST",
        &format!("/tasks/lists/{source}/tags"),
        json!({"name":"Rollback tag"}),
    );
    let tag = tag["body"]["tag"]["id"].as_str().unwrap();
    f.route(
        f.owner,
        "POST",
        &format!("/tasks/{}/tags", f.task),
        json!({"tagId":tag}),
    );
    let before = f.route(f.owner, "GET", &format!("/tasks/{}", f.task), Value::Null);
    let lists_before = f.route(f.owner, "GET", "/tasks/lists", Value::Null);
    let next = f.ports.clone();
    f.ports = Arc::new(FailListMove(next.clone()));
    let response = f.route(
        f.owner,
        "DELETE",
        &format!("/tasks/lists/{source}"),
        json!({"reassignToListId":destination}),
    );
    assert_eq!(response["status"], 500);
    f.ports = next;
    assert_eq!(
        f.route(f.owner, "GET", &format!("/tasks/{}", f.task), Value::Null),
        before
    );
    assert_eq!(
        f.route(f.owner, "GET", "/tasks/lists", Value::Null),
        lists_before
    );
    println!("PASS compiled list deletion failure: task, tag assignments and both list records including timestamps are rolled back unchanged");
}

// Only the removal control replaces identifier-preserving UPDATEs with real
// SELECTs. Both workers still run compiled guest code and real transactions.
#[derive(Default)]
struct ProtectedOverlap {
    leader: Option<Uuid>,
    attempted: bool,
    committed: bool,
    counts: Vec<usize>,
}
fn assert_database_lock_wait() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let (db, connection) = tokio_postgres::connect(
            &std::env::var("JS51_BOOTSTRAP_URL").unwrap(), NoTls,
        ).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        for _ in 0..150 {
            let waiting: bool = db.query_one(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%task_lists%' AND cardinality(pg_blocking_pids(pid)) > 0)", &[],
            ).await.unwrap().get(0);
            if waiting { return; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("Second deletion must actually wait on a PostgreSQL list lock");
    });
}
struct DeleteRace {
    next: Arc<dyn Ports>,
    remove_locks: bool,
    unlocked: std::sync::Mutex<std::collections::BTreeSet<Uuid>>,
    counted: (std::sync::Mutex<usize>, std::sync::Condvar),
    protected: (std::sync::Mutex<ProtectedOverlap>, std::sync::Condvar),
}
impl Ports for DeleteRace {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port != "db" || r.resource != "app.task_lists" {
            return self.next.invoke(scope, port, r);
        }
        let query: Query = serde_json::from_value(r.parameters.clone())?;
        if query.kind == moss_module_sdk::query::Kind::Update
            && query.values.len() == 1
            && query.values.contains_key("id")
        {
            if !self.remove_locks {
                let (state, ready) = &self.protected;
                let mut state = state.lock().unwrap();
                match state.leader {
                    None => state.leader = Some(scope.call_id()),
                    Some(leader) if leader != scope.call_id() => {
                        state.attempted = true;
                        ready.notify_all();
                    }
                    _ => {}
                }
                drop(state);
            }
            let output = if self.remove_locks {
                self.next.invoke(
                    scope,
                    port,
                    &Request {
                        operation: r.operation.clone(),
                        resource: r.resource.clone(),
                        parameters: serde_json::to_value(Query::select(query.filter))?,
                    },
                )?
            } else {
                self.next.invoke(scope, port, r)?
            };
            self.unlocked.lock().unwrap().insert(scope.call_id());
            return Ok(output);
        }
        let output = self.next.invoke(scope, port, r)?;
        if query.kind == moss_module_sdk::query::Kind::Select
            && query.filter == Filter::Owned
            && self.unlocked.lock().unwrap().remove(&scope.call_id())
        {
            if !self.remove_locks {
                let (state, ready) = &self.protected;
                let mut state = state.lock().unwrap();
                if state.leader == Some(scope.call_id()) {
                    assert_eq!(output.as_array().unwrap().len(), 2);
                    let (next, _) = ready
                        .wait_timeout_while(state, std::time::Duration::from_secs(5), |s| {
                            !s.attempted
                        })
                        .unwrap();
                    state = next;
                    assert!(
                        state.attempted,
                        "Second deletion must send its lock request"
                    );
                    drop(state);
                    // The first transaction is held here until the real database
                    // reports the second one blocked on its list row lock.
                    assert_database_lock_wait();
                    state = self.protected.0.lock().unwrap();
                } else {
                    assert_eq!(output.as_array().unwrap().len(), 1);
                    let (next, _) = ready
                        .wait_timeout_while(state, std::time::Duration::from_secs(5), |s| {
                            !s.committed
                        })
                        .unwrap();
                    state = next;
                    assert!(state.committed, "Second count follows the first commit");
                }
                state.counts.push(output.as_array().unwrap().len());
                return Ok(output);
            }
            // Hold the two actual count results before either guest can delete.
            let (count, ready) = &self.counted;
            let mut count = count.lock().unwrap();
            *count += 1;
            ready.notify_all();
            let (count, _) = ready
                .wait_timeout_while(count, std::time::Duration::from_secs(10), |count| {
                    *count < 2
                })
                .unwrap();
            anyhow::ensure!(*count == 2, "Concurrent count rendezvous timed out");
        }
        Ok(output)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)?;
        if !self.remove_locks {
            let (state, ready) = &self.protected;
            let mut state = state.lock().unwrap();
            if state.leader == Some(scope.call_id()) {
                state.committed = success;
                ready.notify_all();
            }
        }
        Ok(())
    }
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_parallel_deletes_keep_the_last_list_with_lock_removal_control() {
    let mut f = Fixture::open_with(true);
    let protected = f.ports.clone();
    for remove_locks in [true, false] {
        let actor = if remove_locks { f.other } else { f.owner };
        let first = create_list(&f, actor, "First");
        let second = create_list(&f, actor, "Second");
        let race = Arc::new(DeleteRace {
            next: protected.clone(),
            remove_locks,
            unlocked: Default::default(),
            counted: Default::default(),
            protected: Default::default(),
        });
        f.ports = race.clone();
        let start = std::sync::Barrier::new(2);
        let statuses = std::thread::scope(|threads| {
            let one = threads.spawn(|| {
                start.wait();
                f.route(actor, "DELETE", &format!("/tasks/lists/{first}"), json!({}))["status"]
                    .as_u64()
                    .unwrap()
            });
            let two = threads.spawn(|| {
                start.wait();
                f.route(
                    actor,
                    "DELETE",
                    &format!("/tasks/lists/{second}"),
                    json!({}),
                )["status"]
                    .as_u64()
                    .unwrap()
            });
            let mut statuses = vec![one.join().unwrap(), two.join().unwrap()];
            statuses.sort();
            statuses
        });
        let remaining =
            f.rt.block_on(f.db.query_one(
                "SELECT count(*) FROM app.task_lists WHERE owner_user_id=$1",
                &[&actor],
            ))
            .unwrap()
            .get::<_, i64>(0);
        let assert_last_list = || {
            assert_eq!(
                statuses,
                vec![200, 409],
                "Only one concurrent delete may succeed"
            );
            assert_eq!(remaining, 1, "The last list must remain");
        };
        if remove_locks {
            assert_eq!(statuses, vec![200, 200]);
            assert_eq!(remaining, 0);
            assert!(std::panic::catch_unwind(assert_last_list).is_err());
        } else {
            assert_last_list();
            assert_eq!(race.protected.0.lock().unwrap().counts, vec![2, 1]);
        }
        f.ports = protected.clone();
    }
    println!("PASS compiled concurrent deletion: exact last-list assertion fails with row locks removed and passes with locks restored");
}

#[test]
#[ignore = "Database work only through the Tasks verify-gate"]
fn compiled_list_deletion_moves_a_thousand_tagged_tasks() {
    let f = Fixture::open_with(true);
    let source = create_list(&f, f.owner, "Large source");
    let destination = create_list(&f, f.owner, "Large destination");
    let tag = f.route(
        f.owner,
        "POST",
        &format!("/tasks/lists/{source}/tags"),
        json!({"name":"Source tag"}),
    );
    let tag = tag["body"]["tag"]["id"].as_str().unwrap();
    f.sql(&format!(
        "INSERT INTO app.tasks(owner_user_id,list_id,title) SELECT '{}'::uuid,'{}'::uuid,'Large task ' || n FROM generate_series(1,1011) n; INSERT INTO app.task_tag_assignments(task_id,tag_id) SELECT id,'{}'::uuid FROM app.tasks WHERE list_id='{}'::uuid",
        f.owner, source, tag, source,
    ));
    let response = f.route(
        f.owner,
        "DELETE",
        &format!("/tasks/lists/{source}"),
        json!({"reassignToListId":destination}),
    );
    assert_eq!(
        response["status"], 200,
        "Default guest limits must support bulk list deletion"
    );
    let counts = f.rt.block_on(f.db.query_one(
        "SELECT (SELECT count(*) FROM app.tasks WHERE list_id=$1::uuid) AS tasks, (SELECT count(*) FROM app.task_tag_assignments a JOIN app.tasks t ON t.id=a.task_id WHERE t.list_id=$1::uuid) AS links, (SELECT count(*) FROM app.task_lists WHERE id=$2::uuid) AS source",
        &[&Uuid::parse_str(&destination).unwrap(), &Uuid::parse_str(&source).unwrap()],
    )).unwrap();
    assert_eq!(counts.get::<_, i64>(0), 1011);
    assert_eq!(counts.get::<_, i64>(1), 0);
    assert_eq!(counts.get::<_, i64>(2), 0);
    println!("PASS compiled bulk deletion: all 1011 tagged tasks moved and source assignments removed under default guest limits");
}
