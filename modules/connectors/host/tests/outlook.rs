//! Outlook calendar reader proofs: the real Rust package in WebAssembly, the real host and
//! database, and an invented stand-in page. Calendar and the job queue are recorded stand-ins,
//! so the proof covers what leaves the package. Run only through scripts/run-gate.sh.
use access_context::AccessContext;
use moss_connectors_host::{outlook_scan::OutlookBinding, package, ConnectorsPorts};
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use moss_standins::outlook::{OutlookConfig, OutlookStandIn};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const ADDRESS: &str = "SENTINEL-ADDRESS@example.invalid";
const TITLE: &str = "SENTINEL-EVENT-TITLE";
const QUEUE: &str = "outlook-calendar";

#[derive(Clone)]
struct Call {
    port: String,
    resource: String,
    operation: String,
    params: Value,
}

/// Records what the package sends to Calendar and the job queue.
#[derive(Default)]
struct Seen(Mutex<Vec<Call>>);

impl Ports for Seen {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let name = request.parameters["name"].as_str().unwrap_or(&request.operation).to_string();
        self.0.lock().unwrap().push(Call {
            port: port.into(),
            resource: request.resource.clone(),
            operation: request.operation.clone(),
            params: request.parameters.clone(),
        });
        Ok(match (port, name.as_str()) {
            ("context", "read") => json!({"now":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}),
            ("context", _) => json!({"id":Uuid::new_v4().to_string()}),
            ("jobs", _) => json!({"id":Uuid::new_v4().to_string()}),
            ("api", _) => json!({"unconfirmed":0}),
            _ => anyhow::bail!("unexpected {port}"),
        })
    }
}

impl Seen {
    fn all(&self) -> Vec<Call> {
        self.0.lock().unwrap().clone()
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    page: OutlookStandIn,
    seen: Arc<Seen>,
    ports: Arc<ConnectorsPorts>,
    a: Uuid,
    b: Uuid,
    cursor: Mutex<usize>,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db, page) = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Outlook A',true),($2,$4,'Outlook B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App).await.unwrap();
            let page = OutlookStandIn::start(OutlookConfig { address: ADDRESS.into(), ..OutlookConfig::default() }).await;
            page.add_event("e1", TITLE, "10 AM to 10:30 AM", 1);
            page.add_event("e2", "Later invented review", "2 PM to 3 PM", 9);
            (root, db, page)
        });
        let seen = Arc::new(Seen::default());
        let binding = OutlookBinding::new(&page.endpoint(), a, ADDRESS);
        assert!(binding.is_some());
        let ports = Arc::new(ConnectorsPorts::new(db, seen.clone(), KEY).unwrap().with_outlook(binding));
        Self { rt, root, page, seen, ports, a, b, cursor: Mutex::new(0) }
    }

    fn call(&self, actor: Uuid, entry: &str, payload: Value) -> Value {
        let wasm = package::component(&std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("CONNECTORS_CORE_WASM")).unwrap()).unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(&wasm, Arc::new(package::manifest().unwrap()), AccessContext::new(actor, "outlook-proof"), self.ports.clone(), entry, &payload.to_string())
            .unwrap_or_else(|e| panic!("{entry}: {e}"));
        serde_json::from_str(&out).unwrap()
    }

    fn route(&self, actor: Uuid, method: &str, path: &str) -> (u64, Value) {
        let reply = self.call(actor, "route", json!({"method":method,"path":path,"params":{},"query":{},"body":null}));
        (reply["status"].as_u64().unwrap(), reply["body"].clone())
    }

    /// Runs every Outlook job the package queued since the last call, and the jobs those queue.
    fn drain(&self, actor: Uuid) -> Vec<Value> {
        let mut outcomes = vec![];
        loop {
            let all = self.seen.all();
            let start = *self.cursor.lock().unwrap();
            *self.cursor.lock().unwrap() = all.len();
            let jobs: Vec<Call> = all[start..]
                .iter()
                .filter(|c| c.port == "jobs" && c.operation == "enqueue-options" && c.resource == QUEUE)
                .cloned()
                .collect();
            if jobs.is_empty() {
                return outcomes;
            }
            for job in jobs {
                outcomes.push(self.call(actor, "job", json!({"queue":QUEUE,"parameters":job.params["params"]})));
            }
        }
    }

    fn health_rows(&self) -> Vec<Value> {
        let sql = format!(
            "SELECT value_json FROM app.preferences WHERE key LIKE 'connector.%.outlook_calendar_health' AND owner_user_id IN ('{}','{}')",
            self.a, self.b
        );
        self.rt.block_on(self.root.query(&sql, &[])).unwrap().iter().map(|r| r.get(0)).collect()
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_connected_account_is_read_week_by_week_and_reaches_calendar_through_its_public_call() {
    let f = Fixture::new();
    let (status, body) = f.route(f.a, "POST", "/outlook-calendar/connect");
    assert_eq!((status, body["connected"].clone()), (200, json!(true)), "{body}");
    let outcomes = f.drain(f.a);
    assert!(outcomes.iter().filter(|o| o["outcome"] == "continued").count() >= 4, "{outcomes:?}");
    assert_eq!(outcomes.last().unwrap()["outcome"], "imported", "{outcomes:?}");
    let (_, shown) = f.route(f.a, "GET", "/outlook-calendar");
    assert_eq!(shown["state"], "current", "{shown}");
    let imports: Vec<Call> = f.seen.all().into_iter().filter(|c| c.port == "api" && c.resource == "calendar").collect();
    assert_eq!(imports.len(), 1);
    assert_eq!(imports[0].params["name"], "importCalendarMirror");
    let events = imports[0].params["parameters"]["batch"]["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events.iter().any(|e| e["title"] == TITLE));
    // The stand-in saw the helper protocol and was closed after the run.
    let ops = f.page.ops();
    assert!(ops.contains(&"read-week".to_string()) && ops.last().unwrap() == "close", "{ops:?}");
}

#[test]
#[ignore = "Only through verify-gate"]
fn no_page_text_or_account_address_reaches_a_job_payload_a_health_row_or_a_status() {
    let f = Fixture::new();
    f.route(f.a, "POST", "/outlook-calendar/connect");
    f.drain(f.a);
    let status = f.route(f.a, "GET", "/outlook-calendar").1;
    let rows = f.health_rows();
    assert_eq!(rows.len(), 1);
    // Calendar receives the events by design, so only the queue, the status and the saved
    // health are searched for the page's text.
    let queued: Vec<Call> = f.seen.all().into_iter().filter(|c| c.port == "jobs").collect();
    assert!(!queued.is_empty());
    for call in &queued {
        for value in call.params["params"].as_object().into_iter().flatten().map(|(_, v)| v) {
            assert!(value.is_string() || value.is_boolean(), "ids and flags only");
        }
    }
    let everything = format!("{} {} {}", serde_json::to_string(&queued.iter().map(|c| c.params.clone()).collect::<Vec<_>>()).unwrap(), status, serde_json::to_string(&rows).unwrap());
    for text in [ADDRESS, "SENTINEL-EVENT", "Later invented review", "10 AM"] {
        assert!(!everything.contains(text), "{text} leaked");
    }
    assert!(rows[0]["bindingFingerprint"].is_string());
}

#[test]
#[ignore = "Only through verify-gate"]
fn another_person_cannot_connect_refresh_disconnect_or_read_the_owners_copy() {
    let f = Fixture::new();
    f.route(f.a, "POST", "/outlook-calendar/connect");
    f.drain(f.a);
    let asked = f.page.ops().len();
    for path in ["/outlook-calendar/connect", "/outlook-calendar/refresh", "/outlook-calendar/disconnect"] {
        let (status, body) = f.route(f.b, "POST", path);
        assert_eq!(status, 403, "{path} {body}");
    }
    let (_, theirs) = f.route(f.b, "GET", "/outlook-calendar");
    assert_eq!((theirs["available"].clone(), theirs["connected"].clone()), (json!(false), json!(false)), "{theirs}");
    // A job for the owner's account, run as the other person, finds no account and asks nothing.
    let owner_job = f.seen.all().into_iter().find(|c| c.port == "jobs" && c.resource == QUEUE).unwrap();
    let out = f.call(f.b, "job", json!({"queue":QUEUE,"parameters":owner_job.params["params"]}));
    assert_eq!(out["outcome"], "inactive", "{out}");
    assert_eq!(f.page.ops().len(), asked);
    assert_eq!(f.route(f.a, "GET", "/outlook-calendar").1["state"], "current");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_signed_out_page_stops_the_reader_and_a_moved_binding_refuses_the_next_connect() {
    let f = Fixture::new();
    f.route(f.a, "POST", "/outlook-calendar/connect");
    f.page.sign_out();
    let outcomes = f.drain(f.a);
    assert_eq!(outcomes.last().unwrap()["outcome"], "failed", "{outcomes:?}");
    assert_eq!(f.route(f.a, "GET", "/outlook-calendar").1["state"], "sign-in-needed");
    assert!(f.seen.all().iter().all(|c| !(c.port == "api" && c.resource == "calendar")), "nothing was imported");
    // The same person with the helper now pointing at another account is a changed binding.
    let moved = OutlookBinding::new(&f.page.endpoint(), f.a, "someone-else@example.invalid");
    let ports = Arc::new(ConnectorsPorts::new(
        f.rt.block_on(Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 4, RuntimeRole::App)).unwrap(),
        f.seen.clone(),
        KEY,
    ).unwrap().with_outlook(moved));
    let wasm = package::component(&std::fs::read(std::env::var("CONNECTORS_CORE_WASM").unwrap()).unwrap()).unwrap();
    let request = json!({"method":"POST","path":"/outlook-calendar/connect","params":{},"query":{},"body":null});
    let out = Host::new(Limits::default())
        .unwrap()
        .call(&wasm, Arc::new(package::manifest().unwrap()), AccessContext::new(f.a, "outlook-proof"), ports, "route", &request.to_string())
        .unwrap();
    let reply: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(reply["status"], 409, "{reply}");
}
