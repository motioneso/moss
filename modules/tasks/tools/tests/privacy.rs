//! Real database/host checks. Native fixtures retain the labeled sample trampoline;
//! compiled route fixtures execute the actual Tasks component without that adapter.
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    context::ContextPorts,
    manifest::{Capability, Manifest},
    runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request},
    transactional_database::TransactionalDatabasePorts,
};
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host as GuestHost,
};
use moss_tasks_module::repository::{Error, Repository, Result as TasksResult, TASKS};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::{Client as PgClient, NoTls};
use uuid::Uuid;

#[path = "privacy/account.rs"]
mod account;
#[path = "privacy/actions.rs"]
mod actions;
#[path = "privacy/approval.rs"]
mod approval;
#[path = "privacy/briefing.rs"]
mod briefing;
#[path = "privacy/heartbeat.rs"]
mod heartbeat;
#[path = "privacy/jobs.rs"]
mod jobs;
#[path = "privacy/lists.rs"]
mod lists;
#[path = "privacy/owner_lookup.rs"]
mod owner_lookup;
#[path = "privacy/search.rs"]
mod search;
#[path = "privacy/tags.rs"]
mod tags;

struct NativeHost<'a> {
    scope: &'a CallScope,
    ports: &'a dyn Ports,
}
impl GuestHost for NativeHost<'_> {
    fn call(
        &self,
        port: &str,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> moss_module_sdk::Result<Value> {
        self.ports
            .invoke(
                self.scope,
                port,
                &Request {
                    operation: operation.into(),
                    resource: resource.into(),
                    parameters,
                },
            )
            .map_err(|_| moss_module_sdk::Error::new("Host call failed"))
    }
}
struct NativeFixture {
    next: Arc<dyn Ports>,
}
impl Ports for NativeFixture {
    fn invoke(&self, scope: &CallScope, port: &str, r: &Request) -> Result<Value> {
        if port != "kv" || r.resource != "native-tasks-check" {
            return self.next.invoke(scope, port, r);
        }
        let host = NativeHost {
            scope,
            ports: self.next.as_ref(),
        };
        let repo = Repository::new(&host);
        let p = &r.parameters;
        let id = p["id"].as_str().unwrap_or_default();
        let name = p["name"].as_str().unwrap_or_default();
        let list = p["list"].as_str().unwrap_or_default();
        let tag = p["tag"].as_str().unwrap_or_default();
        let result: TasksResult<Value> = (|| {
            Ok(match p["action"].as_str().unwrap() {
                "task" => repo.task(id)?.map(|t| t.dto(&[])).unwrap_or(Value::Null),
                "tasks" => json!(repo
                    .persisted_tasks()?
                    .iter()
                    .map(|t| t.dto(&[]))
                    .collect::<Vec<_>>()),
                "title" => repo
                    .set_task_title(id, name)?
                    .map(|t| t.dto(&[]))
                    .unwrap_or(Value::Null),
                "lists" => json!(repo.lists()?.iter().map(|t| t.dto()).collect::<Vec<_>>()),
                "create-list" => repo.get_or_create_list(name)?.dto(),
                "rename-list" => repo.rename_list(id, name)?.dto(),
                "tags" => json!(repo.tags(list)?.iter().map(|t| t.dto()).collect::<Vec<_>>()),
                "create-tag" => repo.create_tag(list, name)?.dto(),
                "rename-tag" => repo.rename_tag(list, id, name)?.dto(),
                "delete-tag" => {
                    repo.delete_tag(list, id)?;
                    Value::Null
                }
                "assign" => {
                    repo.assign_tag(id, tag)?;
                    Value::Null
                }
                "unassign" => {
                    repo.unassign_tag(id, tag)?;
                    Value::Null
                }
                "task-tags" => json!(repo
                    .task_tags(id)?
                    .iter()
                    .map(|t| t.dto())
                    .collect::<Vec<_>>()),
                "activity" => json!(repo
                    .activity(id)?
                    .iter()
                    .map(|t| t.dto())
                    .collect::<Vec<_>>()),
                "add-activity" => repo.add_activity(id, "comment", Some(name))?.dto(),
                "preferences" => repo.preferences()?.dto(),
                "set-view" => repo.set_default_view(name)?.dto(),
                "rollback" => {
                    repo.rename_list(id, name)?;
                    return Err(Error::Http(409, "Rollback fixture"));
                }
                "forge-owner" => json!(Client(&host).query(
                    TASKS,
                    &Query::insert(
                        json!({"owner_user_id":p["owner"],"title":"forged","list_id":list})
                            .as_object()
                            .unwrap()
                            .clone()
                            .into_iter()
                            .collect()
                    )
                )?),
                "raw-read" => json!(Client(&host)
                    .query(p["table"].as_str().unwrap(), &Query::select(Filter::All))?),
                _ => panic!("unknown test action"),
            })
        })();
        match result {
            Ok(value) => Ok(json!({"status":200,"body":value})),
            Err(error @ (Error::Http(..) | Error::Request(..))) => {
                Ok(serde_json::to_value(error.response())?)
            }
            Err(Error::Host(_)) => anyhow::bail!("Native Tasks host call failed"),
        }
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}
struct Fixture {
    rt: tokio::runtime::Runtime,
    db: PgClient,
    host: Host,
    ports: Arc<dyn Ports>,
    manifest: Arc<Manifest>,
    wasm: Vec<u8>,
    owner: Uuid,
    other: Uuid,
    admin: Uuid,
    task: Uuid,
}
impl Fixture {
    fn open() -> Self {
        Self::open_with(false)
    }
    fn open_with(component: bool) -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let admin = Uuid::new_v4();
        let task = Uuid::new_v4();
        let (db,database)=rt.block_on(async {
            let (db,c)=tokio_postgres::connect(&std::env::var("JS51_BOOTSTRAP_URL").unwrap(),NoTls).await.unwrap();
            tokio::spawn(async move{let _=c.await;});
            db.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$4,'Tasks owner',false),($2,$5,'Other user',false),($3,$6,'Instance admin',true)",
                &[&owner,&other,&admin,&format!("{owner}@example.test"),&format!("{other}@example.test"),&format!("{admin}@example.test")]).await.unwrap();
            let app=Database::connect(&std::env::var("JS51_APP_URL").unwrap(),4,RuntimeRole::App).await.unwrap();
            (db,app)
        });
        let mut manifest = moss_tasks_checks::manifest().unwrap();
        if !component {
            manifest.capabilities.push(Capability {
                port: "kv".into(),
                operations: ["run".into()].into(),
                resources: ["native-tasks-check".into()].into(),
                allow_private: false,
            });
        }
        let next = Arc::new(ContextPorts::new(Arc::new(
            TransactionalDatabasePorts::new(database, Arc::new(DenyPorts)).unwrap(),
        )));
        let ports: Arc<dyn Ports> = if component {
            next
        } else {
            Arc::new(NativeFixture { next })
        };
        let wasm = wat::parse_str(include_str!(
            "../../../../rust-spike/module-host/sample/module.wat"
        ))
        .unwrap();
        let wasm = if component {
            std::fs::read(std::env::var_os("TASKS_COMPONENT").expect("Build Tasks component first"))
                .unwrap()
        } else {
            wasm
        };
        Self {
            rt,
            db,
            host: Host::new(Limits::default()).unwrap(),
            ports,
            manifest: Arc::new(manifest),
            wasm,
            owner,
            other,
            admin,
            task,
        }
    }
    fn run(&self, actor: Uuid, parameters: Value) -> Result<Value> {
        let request =
            json!({"operation":"run","resource":"native-tasks-check","parameters":parameters});
        let value = self.host.call(
            &self.wasm,
            self.manifest.clone(),
            AccessContext::new(actor, "reused-request-id"),
            self.ports.clone(),
            "route",
            &request.to_string(),
        )?;
        Ok(serde_json::from_str(&value)?)
    }
    fn route(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Value {
        self.try_route(actor, method, path, body).unwrap()
    }
    fn tool(&self, actor: Uuid, name: &str, parameters: Value) -> Result<Value> {
        let value = self.host.call(
            &self.wasm,
            self.manifest.clone(),
            AccessContext::new(actor, "component-tool"),
            self.ports.clone(),
            "tool",
            &json!({"tool":name,"parameters":parameters}).to_string(),
        )?;
        Ok(serde_json::from_str(&value)?)
    }
    fn try_route(&self, actor: Uuid, method: &str, path: &str, body: Value) -> Result<Value> {
        let mut request = moss_module_host::dispatch::resolve(&self.manifest.routes, method, path)?;
        request.body = body;
        let value = self.host.call(
            &self.wasm,
            self.manifest.clone(),
            AccessContext::new(actor, "component-route"),
            self.ports.clone(),
            "route",
            &serde_json::to_string(&request)?,
        )?;
        Ok(serde_json::from_str(&value)?)
    }
    fn body(&self, actor: Uuid, parameters: Value) -> Value {
        let result = self.run(actor, parameters).unwrap();
        assert_eq!(result["status"], 200);
        result["body"].clone()
    }
    fn sql(&self, sql: &str) {
        self.rt.block_on(self.db.batch_execute(sql)).unwrap();
    }
    fn seed_task(&self, list: &str) {
        self.rt.block_on(self.db.execute("INSERT INTO app.tasks(id,owner_user_id,list_id,title) VALUES($1,$2,$3::text::uuid,'Owner private task')",&[&self.task,&self.owner,&list])).unwrap();
    }
    fn private_read(&self, actor: Uuid) {
        assert_eq!(
            self.body(actor, json!({"action":"tasks"})),
            json!([]),
            "another account must not see private Tasks"
        );
    }
    fn private_write(&self, actor: Uuid) {
        assert_eq!(
            self.body(
                actor,
                json!({"action":"title","id":self.task,"name":"forbidden"})
            ),
            Value::Null,
            "another account must not change private Tasks"
        );
    }
    fn isolated(&self, actor: Uuid) {
        self.private_read(actor);
        self.private_write(actor);
    }
}

#[test]
#[ignore = "Database work only through modules/tasks/tools/gate.sh and verify-gate"]
fn compiled_read_tools_keep_actor_scope_and_legacy_result_shapes() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Tool list"}));
    let list = list["body"]["list"]["id"].as_str().unwrap();
    let task = f.route(
        f.owner,
        "POST",
        "/tasks",
        json!({"title":123,"listId":list}),
    );
    assert_eq!(
        task["status"], 201,
        "schema coerces numeric titles before handler parsing"
    );
    assert_eq!(task["body"]["task"]["title"], "123");
    let id = task["body"]["task"]["id"].as_str().unwrap();
    let tag = f.route(
        f.owner,
        "POST",
        &format!("/tasks/lists/{list}/tags"),
        json!({"name":"tool tag"}),
    );
    let tag = tag["body"]["tag"]["id"].as_str().unwrap();
    f.route(
        f.owner,
        "POST",
        &format!("/tasks/{id}/tags"),
        json!({"tagId":tag}),
    );
    for i in 0..12 {
        f.route(
            f.owner,
            "POST",
            &format!("/tasks/{id}/activity"),
            json!({"body":format!("comment {i}")}),
        );
    }
    let detail = f.tool(f.owner, "tasks.get", json!({"taskId":id})).unwrap();
    assert_eq!(detail["data"]["task"]["title"], "123");
    assert_eq!(detail["data"]["task"]["tags"][0]["id"], tag);
    assert_eq!(detail["data"]["subtasks"], json!([]));
    assert_eq!(detail["data"]["activity"].as_array().unwrap().len(), 10);
    assert_eq!(detail["data"]["activity"][0]["body"], "comment 2");
    assert_eq!(detail["data"]["activity"][9]["body"], "comment 11");
    assert_eq!(
        f.tool(f.owner, "tasks.listLists", json!({})).unwrap()["data"]["items"][0]["id"],
        list
    );
    assert_eq!(
        f.tool(f.owner, "tasks.listTags", json!({"listId":list}))
            .unwrap()["data"]["items"][0]["id"],
        tag
    );
    assert_eq!(
        f.tool(f.owner, "tasks.activity", json!({"taskId":id}))
            .unwrap()["data"]["items"]
            .as_array()
            .unwrap()
            .len(),
        12
    );
    for actor in [f.other, f.admin] {
        assert_eq!(
            f.tool(actor, "tasks.get", json!({"taskId":id})).unwrap(),
            json!({"data":{"error":"Task not found"}})
        );
        for (name, params) in [
            ("tasks.listLists", json!({})),
            ("tasks.listTags", json!({"listId":list})),
            ("tasks.activity", json!({"taskId":id})),
        ] {
            assert_eq!(
                f.tool(actor, name, params).unwrap(),
                json!({"data":{"items":[]}})
            );
        }
    }
    assert!(f.tool(f.owner, "tasks.get", json!({})).is_err());
    assert!(f.tool(f.owner, "tasks.unknown", json!({})).is_err());
    let private_read = || {
        assert_eq!(
            f.tool(f.other, "tasks.get", json!({"taskId":id})).unwrap(),
            json!({"data":{"error":"Task not found"}}),
            "compiled Tasks read tool must hide another account's task"
        );
    };
    f.sql("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(private_read)).is_err();
    f.sql("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY");
    assert!(
        failed,
        "the same tool assertion must fail with Tasks RLS removed"
    );
    private_read();
    println!("PASS compiled Tasks tool: identical cross-account read assertion fails with RLS removed, then passes with RLS restored");
}
#[test]
#[ignore = "Database work only through modules/tasks/tools/gate.sh and verify-gate"]
fn native_tasks_use_real_legacy_tables_and_private_host_transactions() {
    let f = Fixture::open();
    let list = f.body(f.owner, json!({"action":"create-list","name":"Personal"}));
    let list_id = list["id"].as_str().unwrap();
    f.seed_task(list_id);
    let lower = f.body(f.owner, json!({"action":"create-list","name":"personal"}));
    assert_eq!(lower["id"], list["id"]);
    let literal = f.body(
        f.owner,
        json!({"action":"create-list","name":"100%_literal\\list"}),
    );
    assert_ne!(literal["id"], list["id"]);
    assert_eq!(
        f.body(
            f.owner,
            json!({"action":"create-list","name":"100%_literal\\list"})
        )["id"],
        literal["id"]
    );
    let tag = f.body(
        f.owner,
        json!({"action":"create-tag","list":list_id,"name":"Private tag"}),
    );
    let tag_id = tag["id"].as_str().unwrap();
    let duplicate_list = f
        .run(
            f.owner,
            json!({"action":"rename-list","id":literal["id"],"name":"pErSoNaL"}),
        )
        .unwrap();
    assert_eq!(duplicate_list["status"], 409);
    assert_eq!(
        duplicate_list["body"]["error"],
        "A list with that name already exists"
    );
    let second_tag = f.body(
        f.owner,
        json!({"action":"create-tag","list":list_id,"name":"Second tag"}),
    );
    let duplicate_tag = f.run(f.owner, json!({"action":"rename-tag","list":list_id,"id":second_tag["id"],"name":"pRiVaTe TaG"})).unwrap();
    assert_eq!(duplicate_tag["status"], 409);
    assert_eq!(
        duplicate_tag["body"]["error"],
        "A tag with that name already exists in this list"
    );

    f.body(f.owner, json!({"action":"assign","id":f.task,"tag":tag_id}));
    f.body(f.owner, json!({"action":"assign","id":f.task,"tag":tag_id}));
    assert_eq!(
        f.body(f.owner, json!({"action":"task-tags","id":f.task}))
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.body(
        f.owner,
        json!({"action":"add-activity","id":f.task,"name":"Private activity"}),
    );
    assert_eq!(
        f.body(f.owner, json!({"action":"set-view","name":"matrix"}))["defaultView"],
        "matrix"
    );
    for actor in [f.other, f.admin] {
        f.isolated(actor);
        for table in moss_tasks_module::repository::TABLES {
            assert_eq!(
                f.body(actor, json!({"action":"raw-read","table":table})),
                json!([]),
                "Hidden table: {table}"
            );
        }
        for parameters in [
            json!({"action":"rename-list","id":list_id,"name":"foreign"}),
            json!({"action":"create-tag","list":list_id,"name":"foreign"}),
            json!({"action":"rename-tag","list":list_id,"id":tag_id,"name":"foreign"}),
            json!({"action":"delete-tag","list":list_id,"id":tag_id}),
            json!({"action":"assign","id":f.task,"tag":tag_id}),
            json!({"action":"unassign","id":f.task,"tag":tag_id}),
        ] {
            assert_eq!(f.run(actor, parameters).unwrap()["status"], 404);
        }
        assert!(f
            .run(
                actor,
                json!({"action":"add-activity","id":f.task,"name":"foreign"})
            )
            .is_err());
        assert!(f
            .run(
                actor,
                json!({"action":"forge-owner","owner":f.owner,"list":list_id})
            )
            .is_err());
    }
    assert_eq!(
        f.run(
            f.owner,
            json!({"action":"rollback","id":list_id,"name":"must roll back"})
        )
        .unwrap()["status"],
        409
    );
    assert_eq!(
        f.body(f.owner, json!({"action":"lists"}))
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["id"] == list["id"])
            .unwrap()["name"],
        "Personal"
    );
    let private = f.body(f.owner, json!({"action":"task","id":f.task}));
    assert_eq!(private["title"], "Owner private task");
    assert!(private.get("external_key").is_none());
    // Explicit manage sharing grants the task, but never the owner's lists/tags/preferences.
    f.rt.block_on(f.db.execute("INSERT INTO app.shares(resource_type,resource_id,owner_user_id,grantee_user_id,level) VALUES('task',$1,$2,$3,'manage')",&[&f.task,&f.owner,&f.other])).unwrap();
    assert_eq!(
        f.body(
            f.other,
            json!({"action":"title","id":f.task,"name":"Explicitly shared"})
        )["title"],
        "Explicitly shared"
    );
    assert_eq!(
        f.body(f.other, json!({"action":"task-tags","id":f.task})),
        json!([])
    );
    assert_eq!(
        f.run(
            f.other,
            json!({"action":"unassign","id":f.task,"tag":tag_id})
        )
        .unwrap()["status"],
        404
    );
    assert_eq!(f.body(f.other, json!({"action":"lists"})), json!([]));
    assert_eq!(
        f.body(f.other, json!({"action":"preferences"}))["defaultView"],
        "priority"
    );
    assert_eq!(
        f.body(f.owner, json!({"action":"preferences"}))["defaultView"],
        "matrix"
    );
    println!("PASS native Tasks data through real host: six original tables, other-user/admin privacy, forged ownership refusal, owner-only assignments, explicit manage share and failed-invocation rollback");
}
#[test]
#[ignore = "Database work only through modules/tasks/tools/gate.sh and verify-gate"]
fn privacy_assertion_requires_rls() {
    let f = Fixture::open();
    let list = f.body(f.owner, json!({"action":"create-list","name":"Personal"}));
    f.seed_task(list["id"].as_str().unwrap());
    f.isolated(f.other);
    f.sql("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
    let read_control =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.private_read(f.other)));
    let write_control =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.private_write(f.other)));
    // Restore before inspecting the assertions so failed controls cannot contaminate later tests.
    f.sql("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY");
    assert!(
        read_control.is_err(),
        "private-read assertion must fail when RLS is removed"
    );
    assert!(
        write_control.is_err(),
        "private-write assertion must fail when RLS is removed"
    );
    assert_eq!(
        f.body(f.owner, json!({"action":"task","id":f.task}))["title"],
        "forbidden"
    );
    f.isolated(f.other);
    println!("PASS the same private-read and private-write assertions fail with Tasks RLS disabled and passes with RLS restored");
}

#[test]
#[ignore = "Database work only through verify-gate"]
fn compiled_tasks_routes_enforce_privacy_and_complete_recurring_tasks() {
    let f = Fixture::open_with(true);
    let list = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Personal"}));
    assert_eq!(list["status"], 201);
    let list_id = list["body"]["list"]["id"].as_str().unwrap();
    f.seed_task(list_id);
    let id = f.task.to_string();
    let path = format!("/tasks/{id}");
    let private_read = || {
        let reply = f.route(f.other, "GET", "/tasks", Value::Null);
        assert_eq!(reply["status"], 200);
        assert_eq!(
            reply["body"]["tasks"],
            json!([]),
            "compiled Tasks must hide another account's rows"
        );
    };
    let private_write = || {
        let reply = f.route(f.other, "PATCH", &path, json!({"title":"forbidden"}));
        assert_eq!(
            reply["status"], 404,
            "compiled Tasks must refuse another account's update"
        );
    };
    f.sql("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY");
    let read_failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(private_read)).is_err();
    let write_failed =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(private_write)).is_err();
    f.sql("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY");
    assert!(
        read_failed && write_failed,
        "both compiled privacy controls must fail with RLS removed"
    );
    private_read();
    private_write();
    assert_eq!(
        f.route(f.owner, "GET", &path, Value::Null)["body"]["task"]["title"],
        "forbidden"
    );
    assert_eq!(f.route(f.other, "GET", &path, Value::Null)["status"], 404);
    println!("PASS compiled Tasks: identical read/write privacy assertions fail with RLS removed, then pass with RLS restored");
    assert_eq!(f.route(f.admin, "GET", &path, Value::Null)["status"], 404);
    assert_eq!(
        f.route(f.admin, "PATCH", &path, json!({"title":"admin forbidden"}))["status"],
        404
    );
    let created = f.route(f.owner,"POST","/tasks",json!({"title":"Daily check","recurrence":{"freq":"daily","interval":1,"occurrence_date":"2099-01-01"}}));
    assert_eq!(created["status"], 201, "{created}");
    let recurring = created["body"]["task"]["id"].as_str().unwrap();
    let closed = f.route(
        f.owner,
        "PATCH",
        &format!("/tasks/{recurring}"),
        json!({"status":"done"}),
    );
    assert_eq!(closed["status"], 200, "{closed}");
    let tasks = f.route(f.owner, "GET", "/tasks", Value::Null);
    let tasks = tasks["body"]["tasks"].as_array().unwrap();
    assert!(
        tasks
            .iter()
            .any(|t| t["source"] == "recurrence"
                && t["recurrence"]["occurrence_date"] == "2099-01-02")
    );
    assert_eq!(tasks.len(), 3);
    assert!(tasks
        .iter()
        .all(|task| task["ownerUserId"] == f.owner.to_string()));
    let closed = f.route(
        f.owner,
        "PATCH",
        &format!("/tasks/{recurring}"),
        json!({"status":"done"}),
    );
    assert_eq!(closed["status"], 200);
    assert_eq!(
        f.route(f.owner, "GET", "/tasks", Value::Null)["body"]["tasks"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    println!("PASS compiled Tasks: admin denied; recurring completion creates one next occurrence and repeated completion stays idempotent");
}

#[test]
#[ignore = "Database work only through verify-gate"]
fn compiled_routes_preserve_tags_moves_nullable_fields_and_completion_cascades() {
    let f = Fixture::open_with(true);
    let first = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"First"}));
    assert_eq!(first["status"], 201);
    let first = first["body"]["list"]["id"].as_str().unwrap();
    let second = f.route(f.owner, "POST", "/tasks/lists", json!({"name":"Second"}));
    assert_eq!(second["status"], 201);
    let second = second["body"]["list"]["id"].as_str().unwrap();
    let create = |title: &str, parent: Option<&str>| {
        let result = f.route(
            f.owner,
            "POST",
            "/tasks",
            json!({
                "title":title,"listId":first,"parentTaskId":parent,
                "dueAt":"2026-11-08T10:00:00+02:00","effort":"quick"
            }),
        );
        assert_eq!(result["status"], 201, "{result}");
        assert_eq!(result["body"]["task"]["dueAt"], "2026-11-08T08:00:00.000Z");
        result["body"]["task"]["id"].as_str().unwrap().to_owned()
    };
    let parent = create("Parent", None);
    let child = create("Child", Some(&parent));
    let tag = f.route(
        f.owner,
        "POST",
        &format!("/tasks/lists/{first}/tags"),
        json!({"name":"Check"}),
    );
    assert_eq!(tag["status"], 201, "{tag}");
    let tag = tag["body"]["tag"]["id"].as_str().unwrap();
    for id in [&parent, &child] {
        let assigned = f.route(
            f.owner,
            "POST",
            &format!("/tasks/{id}/tags"),
            json!({"tagId":tag}),
        );
        assert_eq!(assigned["status"], 200, "{assigned}");
        assert_eq!(
            assigned["body"]["task"]["tags"].as_array().unwrap().len(),
            1
        );
    }
    // The parent UPDATE is rejected by the original self-parent trigger, after
    // child moves and tag cleanup have executed. The host must roll all of it back.
    match f.try_route(
        f.owner,
        "PATCH",
        &format!("/tasks/{parent}"),
        json!({"listId":second,"parentTaskId":parent}),
    ) {
        Err(_) => {}
        Ok(reply) => assert!(reply["status"].as_u64().unwrap() >= 400, "{reply}"),
    }
    for id in [&parent, &child] {
        let row = f.route(f.owner, "GET", &format!("/tasks/{id}"), Value::Null);
        assert_eq!(row["body"]["task"]["listId"], first);
        assert_eq!(row["body"]["task"]["tags"].as_array().unwrap().len(), 1);
    }
    let moved = f.route(
        f.owner,
        "PATCH",
        &format!("/tasks/{parent}"),
        json!({"listId":second,"dueAt":null,"effort":null}),
    );
    assert_eq!(moved["status"], 200, "{moved}");
    assert!(moved["body"]["task"]["dueAt"].is_null());
    assert!(moved["body"]["task"]["effort"].is_null());
    for id in [&parent, &child] {
        let result = f.route(f.owner, "GET", &format!("/tasks/{id}"), Value::Null);
        assert_eq!(result["body"]["task"]["listId"], second);
        assert_eq!(result["body"]["task"]["tags"], json!([]));
    }
    let closed = f.route(
        f.owner,
        "PATCH",
        &format!("/tasks/{child}"),
        json!({"status":"done"}),
    );
    assert_eq!(closed["status"], 200, "{closed}");
    assert_eq!(
        f.route(f.owner, "GET", &format!("/tasks/{parent}"), Value::Null)["body"]["task"]["status"],
        "done"
    );
    let activity = f.route(
        f.owner,
        "GET",
        &format!("/tasks/{parent}/activity"),
        Value::Null,
    );
    assert!(activity["body"]["activity"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["activityType"] == "completed"));
    assert_eq!(
        f.route(
            f.owner,
            "PATCH",
            &format!("/tasks/{parent}"),
            json!({"status":"archived"})
        )["status"],
        200
    );
    assert_eq!(
        f.route(f.owner, "GET", &format!("/tasks/{child}"), Value::Null)["body"]["task"]["status"],
        "archived"
    );
    let view = f.route(
        f.owner,
        "PATCH",
        "/tasks/preferences",
        json!({"defaultView":"matrix"}),
    );
    assert_eq!(view["status"], 200, "{view}");
    assert_eq!(
        f.route(f.owner, "GET", "/tasks/preferences", Value::Null)["body"]["preferences"]
            ["defaultView"],
        "matrix"
    );
    assert_eq!(
        f.route(f.other, "GET", "/tasks/preferences", Value::Null)["body"]["preferences"]
            ["defaultView"],
        "priority"
    );
    println!("PASS compiled Tasks: tags, atomic parent/child list moves, nullable dates, completion cascades, activity and isolated view preferences");
}

#[test]
#[ignore = "Database work only through verify-gate"]
fn compiled_quadrant_queries_match_the_priority_four_boundary() {
    let f = Fixture::open_with(true);
    let mut tasks = vec![];
    for (title, priority) in [("Lower", 3), ("Higher", 4)] {
        let result = f.route(
            f.owner,
            "POST",
            "/tasks",
            json!({"title":title,"priority":priority}),
        );
        assert_eq!(result["status"], 201, "{result}");
        tasks.push(result["body"]["task"].clone());
    }
    let titles = |path: &str| {
        let response = f.route(f.owner, "GET", path, Value::Null);
        assert_eq!(response["status"], 200, "{response}");
        let mut titles: Vec<String> = response["body"]["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap().to_owned())
            .collect();
        titles.sort();
        titles
    };
    assert_eq!(
        titles("/tasks?quadrant=schedule"),
        vec!["Higher"],
        "priority three must not enter the important quadrant"
    );
    assert_eq!(titles("/tasks?quadrant=eliminate"), vec!["Lower"]);
    for task in &tasks {
        assert_eq!(
            f.route(
                f.owner,
                "PATCH",
                &format!("/tasks/{}", task["id"].as_str().unwrap()),
                json!({"dueAt":"2020-01-01T00:00:00Z"})
            )["status"],
            200
        );
    }
    assert_eq!(titles("/tasks?quadrant=do"), vec!["Higher"]);
    assert_eq!(titles("/tasks?quadrant=delegate"), vec!["Lower"]);
    assert_eq!(
        f.route(f.owner, "GET", "/tasks?quadrant=unknown", Value::Null)["status"],
        400
    );
    let list = tasks[1]["listId"].as_str().unwrap();
    let tag = f.route(
        f.owner,
        "POST",
        &format!("/tasks/lists/{list}/tags"),
        json!({"name":"Query check"}),
    );
    assert_eq!(tag["status"], 201, "{tag}");
    let tag = tag["body"]["tag"]["id"].as_str().unwrap();
    assert_eq!(
        f.route(
            f.owner,
            "POST",
            &format!("/tasks/{}/tags", tasks[1]["id"].as_str().unwrap()),
            json!({"tagId":tag})
        )["status"],
        200
    );
    assert_eq!(titles(&format!("/tasks?tagId={tag}")), vec!["Higher"]);
    println!("PASS compiled Tasks: priority-three/four boundary in all quadrants, query rejection and tag query filtering");
}
