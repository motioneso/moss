//! Database proofs for the integrations host. Run only through scripts/run-gate.sh.
use std::sync::{Arc, Mutex};

use access_context::AccessContext;
use async_trait::async_trait;
use axum::{body::Body, http::Request, Router};
use http_body_util::BodyExt;
use moss_integrations::{sortmap::SortedBy, tool::Tool};
use moss_integrations_host::{
    jobs::{Op, SortJobs},
    manifest::queue_specs,
    ports::{DiscoverRequest, Discoverer, Discovery, ModelFailure, SortModel},
    routes::{router, Integrations},
};
use moss_platform_jobs::{Queue, Role};
use safety_core::{
    db::{Database, RuntimeRole},
    secret::SecretCipher,
};
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls};
use tower::ServiceExt;
use uuid::Uuid;

const CREDENTIAL: &str = "MOSS-SENTINEL-credential-7f3a";
const PRIVATE: &str = "MOSS-SENTINEL-private-description-91c2";

/// Returns fixed tools. One tool's description carries the credential, as a leaky service might.
struct Service {
    fail: bool,
}

#[async_trait]
impl Discoverer for Service {
    async fn discover(&self, _: &DiscoverRequest<'_>) -> Result<Discovery, String> {
        if self.fail {
            return Err("Could not reach the service.".into());
        }
        let tool = |name: &str, description: &str| Tool {
            name: name.into(),
            description: description.into(),
            group: String::new(),
            input_schema: Some(json!({"type": "object"})),
            read_only: Some(true),
            idempotent: None,
            ..Default::default()
        };
        Ok(Discovery {
            tools: vec![
                tool("list_things", &format!("List things. {PRIVATE}")),
                tool("leaky_tool", &format!("Uses key {CREDENTIAL} to call out")),
            ],
            base_url: None,
            spec_pasted: false,
        })
    }
}

/// Records every prompt and answers with an empty tool list.
#[derive(Default)]
struct Recorder {
    prompts: Mutex<Vec<String>>,
}

#[async_trait]
impl SortModel for Recorder {
    async fn select(&self, _: Uuid) -> Option<SortedBy> {
        Some(SortedBy { model: "stand-in".into(), provider: "test".into() })
    }
    async fn run(&self, _: Uuid, prompt: &str, _: u32) -> Result<String, ModelFailure> {
        self.prompts.lock().unwrap().push(prompt.to_owned());
        Ok("{\"tools\":[]}".into())
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    app: Router,
    state: Arc<Integrations>,
    worker_db: Database,
    producer: Arc<Queue>,
    worker: Queue,
    model: Arc<Recorder>,
    a: Uuid,
    b: Uuid,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

async fn provision(root: &Client) {
    root.batch_execute("SELECT pg_advisory_lock(246247)").await.unwrap();
    let made: bool = root
        .query_one("SELECT to_regclass('app.integration_connections') IS NOT NULL", &[])
        .await
        .unwrap()
        .get(0);
    if !made {
        let dir = format!("{}/../../../packages/integrations/sql", env!("CARGO_MANIFEST_DIR"));
        for file in [
            "0207_integration_connections.sql",
            "0208_integration_unsuppressed_tools.sql",
            "0209_integration_group_derivation_grandfather.sql",
            "0253_integration_classifier_settings.sql",
            "0268_integration_classifier_sort.sql",
            "0269_integration_classifier_sort_convert.sql",
            "0270_integration_classifier_sort_worker.sql",
            "0272_integration_classifier_prepare_worker.sql",
            "0353_integration_classifier_scan.sql",
        ] {
            root.batch_execute(&std::fs::read_to_string(format!("{dir}/{file}")).unwrap()).await.unwrap();
        }
    }
    let queue: bool = root.query_one("SELECT to_regclass('moss_queue.jobs') IS NOT NULL", &[]).await.unwrap().get(0);
    if !queue {
        root.batch_execute(moss_platform_jobs::MIGRATION).await.unwrap();
    }
    root.batch_execute("SELECT pg_advisory_unlock(246247)").await.unwrap();
}

impl Fixture {
    fn new(service_fails: bool) -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let model = Arc::new(Recorder::default());
        let (root, state, worker_db, producer, worker) = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&env("JS48_BOOTSTRAP_URL"), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            provision(&root).await;
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Int A',false),($2,$4,'Int B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&env("JS48_APP_URL"), 8, RuntimeRole::App).await.unwrap();
            let worker_db = Database::connect(&env("JS48_WORKER_URL"), 8, RuntimeRole::Worker).await.unwrap();
            let producer =
                Arc::new(Queue::connect(&env("JS48_APP_URL"), Role::Producer, queue_specs()).await.unwrap());
            let worker = Queue::connect(&env("JS48_WORKER_URL"), Role::Worker, queue_specs()).await.unwrap();
            let state = Arc::new(Integrations {
                db,
                cipher: Some(Arc::new(SecretCipher::integrations(&Default::default()).unwrap())),
                discoverer: Arc::new(Service { fail: service_fails }),
                model: model.clone(),
                queue: Some(producer.clone()),
            });
            (root, state, worker_db, producer, worker)
        });
        let app = router(state.clone());
        Self { rt, root, app, state, worker_db, producer, worker, model, a, b }
    }

    fn call(&self, actor: Uuid, method: &str, path: &str, body: Option<Value>) -> (u16, Value, String) {
        self.rt.block_on(async {
            let mut request = Request::builder().method(method).uri(path);
            let payload = match body {
                Some(v) => {
                    request = request.header("content-type", "application/json");
                    v.to_string()
                }
                None => String::new(),
            };
            let mut request = request.body(Body::from(payload)).unwrap();
            request.extensions_mut().insert(AccessContext::new(actor, "integrations-proof"));
            let response = self.app.clone().oneshot(request).await.unwrap();
            let status = response.status().as_u16();
            let text = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
            (status, serde_json::from_str(&text).unwrap_or(Value::Null), text)
        })
    }

    fn create(&self, actor: Uuid, name: &str) -> String {
        let (status, body, _) = self.call(
            actor,
            "POST",
            "/api/integrations",
            Some(json!({"name": name, "kind": "mcp", "url": "http://127.0.0.1:9/mcp", "credential": CREDENTIAL,
                "credentialPlacement": {"type": "bearer"}})),
        );
        assert_eq!(status, 201, "{body}");
        body["integration"]["id"].as_str().unwrap().to_owned()
    }

    fn rows_as(&self, actor: Uuid) -> i64 {
        self.rt.block_on(async {
            let cx = safety_core::db::DataContext::open(&self.state.db, &AccessContext::new(actor, "rows")).await.unwrap();
            let n: i64 = cx.db().query_one("SELECT count(*) FROM app.integration_connections", &[]).await.unwrap().get(0);
            cx.commit().await.unwrap();
            n
        })
    }
}

#[test]
#[ignore]
fn routes_keep_the_old_statuses_and_never_return_the_credential() {
    let f = Fixture::new(false);
    let id = f.create(f.a, "svc");
    let base = format!("/api/integrations/{id}");

    let (s, _, text) = f.call(f.a, "GET", "/api/integrations", None);
    assert_eq!(s, 200);
    assert!(!text.contains(CREDENTIAL));
    let (s, _, text) = f.call(f.a, "GET", &base, None);
    assert_eq!((s, text.contains(CREDENTIAL)), (200, false));
    let (s, _, _) = f.call(f.a, "PATCH", &base, Some(json!({"name": "svc2"})));
    assert_eq!(s, 200);
    let (s, _, _) = f.call(f.a, "POST", &format!("{base}/refresh"), None);
    assert_eq!(s, 200);
    let (s, _, _) = f.call(f.a, "PUT", &format!("{base}/classifier/kept-out"), Some(json!({"toolNames": ["list_things"], "keptOut": true})));
    assert_eq!(s, 200);
    let (s, _, _) = f.call(f.a, "PUT", &format!("{base}/classifier/send-without-asking"), Some(json!({"toolNames": ["list_things"], "allow": true})));
    assert_eq!(s, 200);
    let (s, _, _) = f.call(f.a, "POST", &format!("{base}/classifier/sort"), Some(json!({})));
    assert!(s == 200 || s == 202, "sort gave {s}");
    let (s, _, _) = f.call(f.a, "POST", &format!("{base}/classifier/prepare"), Some(json!({})));
    assert!(s == 200 || s == 409, "prepare gave {s}");

    assert_eq!(f.call(f.a, "GET", "/api/integrations/00000000-0000-4000-8000-000000000000", None).0, 404);
    assert_eq!(f.call(f.a, "POST", "/api/integrations", Some(json!({"name": ""}))).0, 400);
    assert_eq!(f.call(f.a, "DELETE", &base, None).0, 204);
    assert_eq!(f.call(f.a, "GET", &base, None).0, 404);
}

#[test]
#[ignore]
fn an_unreachable_service_gives_422() {
    let f = Fixture::new(true);
    let (s, body, _) = f.call(f.a, "POST", "/api/integrations", Some(json!({"name": "x", "kind": "mcp", "url": "http://127.0.0.1:9/mcp"})));
    assert_eq!((s, body["error"].as_str()), (422, Some("Could not reach the service.")));
}

#[test]
#[ignore]
fn a_second_person_sees_nothing_and_the_test_fails_without_the_policy() {
    let f = Fixture::new(false);
    let id = f.create(f.a, "mine");
    let base = format!("/api/integrations/{id}");

    assert_eq!(f.call(f.b, "GET", &base, None).0, 404);
    assert_eq!(f.call(f.b, "PATCH", &base, Some(json!({"name": "stolen"}))).0, 404);
    assert_eq!(f.call(f.b, "DELETE", &base, None).0, 404);
    assert_eq!(f.call(f.b, "GET", "/api/integrations", None).1["integrations"], json!([]));
    assert_eq!(f.rows_as(f.b), 0);
    assert_eq!(f.rows_as(f.a), 1);

    // With the owner policy removed, B reads A's row, so the checks above rely on it.
    f.rt.block_on(async {
        f.root.batch_execute("DROP POLICY integration_connections_owner ON app.integration_connections").await.unwrap();
        f.root
            .batch_execute("CREATE POLICY integration_connections_owner_all ON app.integration_connections FOR ALL TO jarvis_app_runtime USING (true)")
            .await
            .unwrap();
    });
    let leaked = f.rows_as(f.b);
    f.rt.block_on(async {
        f.root.batch_execute("DROP POLICY integration_connections_owner_all ON app.integration_connections").await.unwrap();
        f.root
            .batch_execute(
                "CREATE POLICY integration_connections_owner ON app.integration_connections FOR ALL TO jarvis_app_runtime
                 USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id())",
            )
            .await
            .unwrap();
    });
    assert!(leaked >= 1, "without the policy B should see A's rows");
    assert_eq!(f.rows_as(f.b), 0);
}

#[test]
#[ignore]
fn the_credential_never_reaches_the_model_or_the_queue() {
    let f = Fixture::new(false);
    let id = f.create(f.a, "svc");
    f.rt.block_on(async {
        let jobs = SortJobs { db: f.worker_db.clone(), cipher: f.state.cipher.clone(), model: f.model.clone() };
        jobs.run(f.a, &id, Op::Sort).await.unwrap();
    });
    let prompts = f.model.prompts.lock().unwrap().join("\n");
    assert!(prompts.contains("list_things"), "the ordinary tool is sent: {prompts}");
    assert!(!prompts.contains(CREDENTIAL), "the credential-holding tool must stay out");

    // Queued payloads hold ids and names only.
    let payloads: Vec<String> = f.rt.block_on(async {
        f.root.query("SELECT payload::text FROM moss_queue.jobs", &[]).await.unwrap().iter().map(|r| r.get(0)).collect()
    });
    assert!(!payloads.is_empty());
    for payload in payloads {
        assert!(!payload.contains(CREDENTIAL) && !payload.contains(PRIVATE), "{payload}");
    }
    let stored: String = f.rt.block_on(async {
        f.root.query_one("SELECT credential::text FROM app.integration_connections WHERE id=$1::text::uuid", &[&id]).await.unwrap().get(0)
    });
    assert!(!stored.contains(CREDENTIAL), "stored sealed");
}

#[test]
#[ignore]
fn the_worker_runs_a_queued_sort_through_the_real_queue() {
    let f = Fixture::new(false);
    let id = f.create(f.a, "svc");
    f.rt.block_on(async {
        moss_integrations_host::jobs::enqueue_sort(&f.producer, f.a, &id, Op::Sort).await.unwrap();
        let jobs = SortJobs { db: f.worker_db.clone(), cipher: f.state.cipher.clone(), model: f.model.clone() };
        let mut ran = 0;
        while f.worker.run_one(&jobs).await.unwrap() {
            ran += 1;
            assert!(ran < 10);
        }
        assert!(ran >= 1);
    });
    let (_, body, text) = f.call(f.a, "GET", &format!("/api/integrations/{id}"), None);
    assert!(!text.contains(CREDENTIAL));
    assert_ne!(body["integration"]["classifierSort"], Value::Null, "{text}");
}

#[test]
#[ignore]
fn deleting_the_account_removes_its_connections() {
    let f = Fixture::new(false);
    f.create(f.a, "one");
    f.create(f.a, "two");
    let keep = f.create(f.b, "other");
    f.rt.block_on(async { f.root.execute("DELETE FROM app.users WHERE id=$1", &[&f.a]).await.unwrap() });
    let left: i64 = f.rt.block_on(async {
        f.root.query_one("SELECT count(*) FROM app.integration_connections WHERE owner_user_id=$1", &[&f.a]).await.unwrap().get(0)
    });
    assert_eq!(left, 0);
    assert_eq!(f.call(f.b, "GET", &format!("/api/integrations/{keep}"), None).0, 200);
}
