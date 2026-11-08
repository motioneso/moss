//! Real database/host invocation, native package logic. The Wasm here is a test trampoline,
//! not the Tasks Rust component; it exists only to obtain the real host-owned CallScope.
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
            Err(error @ Error::Http(..)) => Ok(serde_json::to_value(error.response())?),
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
        manifest.capabilities.push(Capability {
            port: "kv".into(),
            operations: ["run".into()].into(),
            resources: ["native-tasks-check".into()].into(),
            allow_private: false,
        });
        let next = Arc::new(ContextPorts::new(Arc::new(
            TransactionalDatabasePorts::new(database, Arc::new(DenyPorts)).unwrap(),
        )));
        let ports = Arc::new(NativeFixture { next });
        let wasm = wat::parse_str(include_str!(
            "../../../../rust-spike/module-host/sample/module.wat"
        ))
        .unwrap();
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
