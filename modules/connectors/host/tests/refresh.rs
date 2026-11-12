//! Email refresh proofs: the real Rust package in WebAssembly, the real host and database, and
//! the stand-in Google and mail servers. Calendar, Email and the job queue are recorded
//! stand-ins, so the proof covers what leaves the package. Run only through scripts/run-gate.sh
//! (see tools/gate.ts).
use access_context::AccessContext;
use moss_connectors_host::{
    google::GoogleConfig,
    imap::MailConfig,
    mail_probe::{Servers, Smtp},
    package, ConnectorsPorts,
};
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use moss_standins::{
    google::{GoogleConfig as FakeGoogle, GoogleStandIn},
    mail::{MailConfig as FakeMailConfig, MailStandIn},
    tls::{self, Identity},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_postgres::{Client, NoTls};
use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer};
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const CLIENT_ID: &str = "fake-client-id.apps.example.com";
const CLIENT_SECRET: &str = "SENTINEL-CLIENT-SECRET-3c9e41";
const ACCESS: &str = "ya29.fake-access-1";
const REFRESH: &str = "1//fake-refresh-1";
const USER: &str = "bob@example.com";
const PASSWORD: &str = "SENTINEL-MAIL-PASSWORD-7f21c9";
const BODY_TEXT: &str = "SENTINEL-MAIL-BODY-text-9d41";
const MODIFY: &str = "https://www.googleapis.com/auth/gmail.modify";

/// One call the package made to a port.
#[derive(Clone)]
struct Call {
    port: String,
    resource: String,
    operation: String,
    params: Value,
}

/// Records what the package sends to Calendar, Email and the job queue. The first
/// `fail_enqueues` queue sends are refused, and a repeated queue key is a duplicate.
#[derive(Default)]
struct Seen {
    calls: Mutex<Vec<Call>>,
    fail_enqueues: Mutex<u32>,
    keys: Mutex<HashSet<(String, String)>>,
}

impl Ports for Seen {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let name = request.parameters["name"].as_str().unwrap_or(&request.operation).to_string();
        self.calls.lock().unwrap().push(Call {
            port: port.into(),
            resource: request.resource.clone(),
            operation: request.operation.clone(),
            params: request.parameters.clone(),
        });
        Ok(match (port, name.as_str()) {
            ("context", "read") => json!({"now":"2026-01-01T00:00:00.000Z"}),
            ("context", _) => json!({"id":Uuid::new_v4().to_string()}),
            ("jobs", "enqueue-options") => {
                let mut left = self.fail_enqueues.lock().unwrap();
                if *left > 0 {
                    *left -= 1;
                    anyhow::bail!("queue refused");
                }
                let key = request.parameters["idempotencyKey"].as_str().unwrap_or("").to_string();
                let fresh = self.keys.lock().unwrap().insert((request.resource.clone(), key));
                if fresh { json!({"id":"job"}) } else { Value::Null }
            }
            ("jobs", _) => json!({"id":"row-1"}),
            ("api", "listCachedMessageKeys") => json!({"keys":[]}),
            ("api", _) => json!({}),
            _ => anyhow::bail!("unexpected {port}"),
        })
    }
}

impl Seen {
    fn all(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
    fn text(&self) -> String {
        self.all().iter().map(|c| format!("{} {} {}", c.resource, c.operation, c.params)).collect()
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    fake: GoogleStandIn,
    mail: MailStandIn,
    ports: Arc<ConnectorsPorts>,
    /// Jobs run as the worker role, as they do in the real server.
    job_ports: Arc<ConnectorsPorts>,
    seen: Arc<Seen>,
    a: Uuid,
    b: Uuid,
    /// How many recorded calls have already been looked at for new jobs.
    cursor: Mutex<usize>,
}

fn der(id: &Identity) -> Vec<u8> {
    CertificateDer::from_pem_slice(id.cert_pem.as_bytes()).unwrap().to_vec()
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db, worker_db, fake, mail) = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Refresh A',true),($2,$4,'Refresh B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App).await.unwrap();
            let worker_db = Database::connect(&std::env::var("JS48_WORKER_URL").unwrap(), 8, RuntimeRole::Worker).await.unwrap();
            let fake = GoogleStandIn::start(FakeGoogle { client_secret: CLIENT_SECRET.into(), ..FakeGoogle::default() }).await;
            let mail = MailStandIn::start(FakeMailConfig { username: USER.into(), password: PASSWORD.into(), tls: Some(&tls::SELF_SIGNED) }).await;
            (root, db, worker_db, fake, mail)
        });
        let servers = Servers {
            imap_host: "127.0.0.1".into(),
            imap_port: mail.imap_addr.port(),
            imap_tls: true,
            smtp_host: "127.0.0.1".into(),
            smtp_port: mail.smtp_addr.port(),
            smtp_security: Smtp::ImplicitTls,
        };
        let seen = Arc::new(Seen::default());
        let build = |db: Database| {
            let google = GoogleConfig::test_only_loopback(&fake.token_url()).unwrap().with_retry_delay(Duration::from_millis(5));
            let imap = MailConfig::test_only_loopback(servers.clone(), vec![der(&tls::SELF_SIGNED)]).unwrap();
            Arc::new(ConnectorsPorts::new(db, seen.clone(), KEY).unwrap().with_google(google).with_mail(imap))
        };
        let ports = build(db);
        let job_ports = build(worker_db);
        Self { rt, root, fake, mail, ports, job_ports, seen, a, b, cursor: Mutex::new(0) }
    }

    fn call(&self, actor: Uuid, entry: &str, payload: Value) -> Value {
        let wasm = package::component(&std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("CONNECTORS_CORE_WASM")).unwrap()).unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(&wasm, Arc::new(package::manifest().unwrap()), AccessContext::new(actor, "refresh-proof"), if entry == "job" { self.job_ports.clone() } else { self.ports.clone() }, entry, &payload.to_string())
            .unwrap_or_else(|e| panic!("{entry} {}: {e}", payload.to_string().chars().take(400).collect::<String>()));
        serde_json::from_str(&out).unwrap()
    }

    fn route(&self, actor: Uuid, method: &str, path: &str, params: Value, body: Value) -> (u64, Value) {
        let reply = self.call(actor, "route", json!({"method":method,"path":path,"params":params,"query":{},"body":body}));
        (reply["status"].as_u64().unwrap(), reply["body"].clone())
    }

    fn start(&self, actor: Uuid, key: Uuid) -> (u64, Value) {
        self.route(actor, "POST", "/email-refresh", json!({}), json!({"idempotencyKey":key.to_string()}))
    }

    fn status(&self, actor: Uuid, id: &str) -> (u64, Value) {
        self.route(actor, "GET", "/email-refresh/:refresh_id", json!({"refresh_id":id}), Value::Null)
    }

    /// Connects Google through the real route and gives the account the scopes a real grant has.
    fn google(&self, actor: Uuid, code: &str) -> Uuid {
        self.fake.issue_code(code);
        let (status, body) = self.route(actor, "POST", "/google/authorize", json!({}), json!({"clientId":CLIENT_ID,"clientSecret":CLIENT_SECRET}));
        assert_eq!(status, 200, "{body}");
        let url = url::Url::parse(body["authUrl"].as_str().unwrap()).unwrap();
        let state = url.query_pairs().find(|(k, _)| k == "state").unwrap().1.to_string();
        let pasted = format!("http://localhost:1/?code={code}&state={state}");
        let (status, body) = self.route(actor, "POST", "/google/complete", json!({}), json!({"redirectUrl":pasted}));
        assert_eq!(status, 201, "{body}");
        let id: Uuid = body["account"]["id"].as_str().unwrap().parse().unwrap();
        self.rt.block_on(self.root.execute("UPDATE app.connector_accounts SET scopes=$2 WHERE id=$1", &[&id, &vec![MODIFY.to_string()]])).unwrap();
        id
    }

    fn imap(&self, actor: Uuid) -> Uuid {
        let (status, body) = self.route(actor, "POST", "/imap/connect", json!({}), json!({"providerId":"imap-fastmail","username":USER,"password":PASSWORD}));
        assert_eq!(status, 201, "{body}");
        body["account"]["id"].as_str().unwrap().parse().unwrap()
    }

    /// Runs every job the package queued since the last call, and the jobs those queue, until none
    /// is left. A repeated queue key was a duplicate and does not run.
    fn drain(&self, actor: Uuid) {
        let mut ran = HashSet::new();
        loop {
            let all = self.seen.all();
            let start = *self.cursor.lock().unwrap();
            *self.cursor.lock().unwrap() = all.len();
            let jobs: Vec<Call> = all[start..]
                .iter()
                .filter(|c| c.port == "jobs" && c.operation == "enqueue-options" && c.resource.starts_with("email-refresh-") && c.resource != "email-refresh-sweep")
                .cloned()
                .collect();
            if jobs.is_empty() {
                return;
            }
            for job in jobs {
                let key = (job.resource.clone(), job.params["idempotencyKey"].to_string());
                if !ran.insert(key) {
                    continue;
                }
                self.call(actor, "job", json!({"queue":job.resource,"parameters":job.params["params"]}));
            }
        }
    }

    fn rows(&self, sql: &str) -> Vec<Value> {
        self.rt.block_on(self.root.query(sql, &[])).unwrap().iter().map(|r| r.get(0)).collect()
    }

    /// Every row of the named refresh tables that belongs to this fixture's two people.
    /// The database is shared by all tests, so a whole-table read would see other tests' rows.
    fn mine(&self, tables: &[&str]) -> Vec<Value> {
        let sql = tables
            .iter()
            .map(|t| format!("SELECT to_jsonb(t) FROM app.{t} t WHERE t.owner_user_id IN ('{}','{}')", self.a, self.b))
            .collect::<Vec<_>>()
            .join(" UNION ALL ");
        self.rows(&sql)
    }

    fn mail_body(&self) {
        let raw = format!("From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: Hello\r\nMessage-ID: <h@example.com>\r\nContent-Type: text/plain\r\n\r\n{BODY_TEXT}");
        self.mail.add_message("INBOX", &raw);
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_refresh_syncs_every_account_and_succeeds() {
    let f = Fixture::new();
    f.google(f.a, "code-ok");
    f.imap(f.a);
    f.mail_body();
    let (status, body) = f.start(f.a, Uuid::new_v4());
    assert_eq!((status, body["enqueued"].clone(), body["deduped"].clone()), (202, json!(true), json!(false)), "{body}");
    let id = body["refreshId"].as_str().unwrap().to_string();
    assert_eq!(f.status(f.a, &id).1["status"], "queued");
    f.drain(f.a);
    let (code, done) = f.status(f.a, &id);
    assert_eq!(code, 200);
    assert_eq!(done["status"], "succeeded", "{done}");
    assert!(done["errorCode"].is_null() && done["completedAt"].is_string() && done["startedAt"].is_string(), "{done}");
    let accounts = done["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 2);
    assert!(accounts.iter().all(|a| a["status"] == "succeeded" && a["errorCode"].is_null()), "{done}");
    let kinds: HashSet<&str> = accounts.iter().map(|a| a["providerType"].as_str().unwrap()).collect();
    assert_eq!(kinds, HashSet::from(["google", "imap"]));
    let imap = accounts.iter().find(|a| a["providerType"] == "imap").unwrap();
    assert_eq!(imap["counts"]["emailUpserted"], 1, "{done}");
    // A refresh reads mail only, so Google Calendar is never asked, and the saved Gmail position is untouched.
    assert!(!f.fake.requests().iter().any(|r| r.contains("/calendar/")), "no Calendar call");
    let google_row = f.rows(&format!("SELECT to_jsonb(a) FROM app.connector_accounts a WHERE owner_user_id='{}' AND provider_id='google'", f.a));
    assert!(google_row[0]["email_history_id"].is_null(), "a recent-only refresh never saves the Gmail position");
}

#[test]
#[ignore = "Only through verify-gate"]
fn no_mail_text_secret_or_address_reaches_a_job_payload_the_status_or_a_refresh_row() {
    let f = Fixture::new();
    f.google(f.a, "code-clean");
    f.imap(f.a);
    f.mail_body();
    let (_, body) = f.start(f.a, Uuid::new_v4());
    let id = body["refreshId"].as_str().unwrap().to_string();
    f.drain(f.a);
    let status = f.status(f.a, &id).1;
    let queued: Vec<Call> = f.seen.all().into_iter().filter(|c| c.port == "jobs" && c.resource.starts_with("email-refresh-")).collect();
    assert!(queued.len() >= 2);
    for call in &queued {
        let params = call.params["params"].as_object().unwrap();
        for (name, value) in params {
            assert!(value.is_string() || value.is_number() || value.is_boolean(), "{name} is metadata");
        }
        assert!(call.params.to_string().len() < 1500);
    }
    let rows = f.mine(&["connector_email_refreshes", "connector_email_refresh_keys", "connector_email_refresh_accounts"]);
    let everything = format!("{} {} {}", f.seen.text(), status, serde_json::to_string(&rows).unwrap());
    for secret in [ACCESS, REFRESH, CLIENT_SECRET, PASSWORD, BODY_TEXT, "alice@example.com", "Hello"] {
        assert!(!everything.contains(secret), "{secret} leaked");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn one_account_failing_makes_the_refresh_partial_with_its_reason() {
    let f = Fixture::new();
    let google = f.google(f.a, "code-partial");
    f.imap(f.a);
    f.fake.revoke_refresh_token(REFRESH);
    f.fake.expire_access_token(ACCESS);
    let (_, body) = f.start(f.a, Uuid::new_v4());
    let id = body["refreshId"].as_str().unwrap().to_string();
    f.drain(f.a);
    let done = f.status(f.a, &id).1;
    assert_eq!(done["status"], "partial", "{done}");
    assert_eq!(done["errorCode"], "auth-error", "one shared reason is kept: {done}");
    let failed = done["accounts"].as_array().unwrap().iter().find(|a| a["accountId"] == google.to_string()).unwrap();
    assert_eq!((failed["status"].clone(), failed["errorCode"].clone()), (json!("failed"), json!("auth-error")));
    let ok = done["accounts"].as_array().unwrap().iter().find(|a| a["providerType"] == "imap").unwrap();
    assert_eq!(ok["status"], "succeeded");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_repeated_key_and_a_second_request_during_a_refresh_share_one_refresh() {
    let f = Fixture::new();
    f.google(f.a, "code-join");
    let key = Uuid::new_v4();
    let first = f.start(f.a, key).1;
    let again = f.start(f.a, key).1;
    assert_eq!(again["refreshId"], first["refreshId"]);
    assert_eq!((again["deduped"].clone(), again["enqueued"].clone()), (json!(true), json!(false)));
    let other = f.start(f.a, Uuid::new_v4()).1;
    assert_eq!((other["refreshId"].clone(), other["deduped"].clone()), (first["refreshId"].clone(), json!(true)));
    let jobs = f.seen.all().into_iter().filter(|c| c.operation == "enqueue-options" && c.resource == "email-refresh-google").count();
    assert_eq!(jobs, 1, "one account job for one refresh");
    f.drain(f.a);
    let after = f.start(f.a, Uuid::new_v4()).1;
    assert_ne!(after["refreshId"], first["refreshId"], "a finished refresh is not joined");
}

#[test]
#[ignore = "Only through verify-gate"]
fn no_eligible_account_ends_failed_and_a_retry_returns_the_same_refresh() {
    let f = Fixture::new();
    let key = Uuid::new_v4();
    let (status, first) = f.start(f.a, key);
    assert_eq!((status, first["enqueued"].clone()), (202, json!(false)));
    let id = first["refreshId"].as_str().unwrap();
    let seen = f.status(f.a, id).1;
    assert_eq!((seen["status"].clone(), seen["errorCode"].clone()), (json!("failed"), json!("no-eligible-accounts")), "{seen}");
    assert_eq!(seen["accounts"], json!([]));
    let retry = f.start(f.a, key).1;
    assert_eq!((retry["refreshId"].clone(), retry["deduped"].clone()), (first["refreshId"].clone(), json!(true)));
    // An account whose Email switch is off, and a disconnected one, are not eligible either.
    let google = f.google(f.a, "code-off");
    f.route(f.a, "PUT", "/accounts/:id/feature-grants", json!({"id":google.to_string()}), json!({"email":false}));
    assert_eq!(f.start(f.a, Uuid::new_v4()).1["enqueued"], false);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_failed_send_stays_pending_and_the_sweep_retries_it_then_gives_up_after_three() {
    let f = Fixture::new();
    f.google(f.a, "code-send");
    *f.seen.fail_enqueues.lock().unwrap() = 1;
    let (_, body) = f.start(f.a, Uuid::new_v4());
    assert_eq!(body["enqueued"], false, "{body}");
    let id = body["refreshId"].as_str().unwrap().to_string();
    let row = f.mine(&["connector_email_refresh_accounts"]);
    assert_eq!((row[0]["dispatch_status"].clone(), row[0]["dispatch_attempts"].clone(), row[0]["status"].clone()), (json!("pending"), json!(1), json!("queued")));
    // The sweep sends it, and the refresh then runs to its end.
    f.call(f.a, "job", json!({"queue":"email-refresh-sweep","parameters":{"round":0}}));
    f.drain(f.a);
    assert_eq!(f.status(f.a, &id).1["status"], "succeeded");
    // A queue that keeps refusing fails the account after three tries.
    let g = Fixture::new();
    g.google(g.a, "code-giveup");
    *g.seen.fail_enqueues.lock().unwrap() = 99;
    let (_, body) = g.start(g.a, Uuid::new_v4());
    let id = body["refreshId"].as_str().unwrap().to_string();
    for _ in 0..3 {
        g.call(g.a, "job", json!({"queue":"email-refresh-sweep","parameters":{"round":0}}));
    }
    let done = g.status(g.a, &id).1;
    assert_eq!((done["status"].clone(), done["errorCode"].clone()), (json!("failed"), json!("enqueue-failed")), "{done}");
    assert_eq!(done["accounts"][0]["errorCode"], "enqueue-failed");
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_sweep_fails_an_account_that_never_finishes_and_stops_when_nothing_is_active() {
    let f = Fixture::new();
    f.google(f.a, "code-stale");
    let (_, body) = f.start(f.a, Uuid::new_v4());
    let id = body["refreshId"].as_str().unwrap().to_string();
    // The account job was sent but never ran, and the refresh is old.
    f.rt.block_on(f.root.execute("UPDATE app.connector_email_refreshes SET created_at = now() - interval '20 minutes'", &[])).unwrap();
    f.call(f.a, "job", json!({"queue":"email-refresh-sweep","parameters":{"round":0}}));
    let done = f.status(f.a, &id).1;
    assert_eq!((done["status"].clone(), done["errorCode"].clone()), (json!("failed"), json!("email-error")), "{done}");
    let unscheduled = f.seen.all().into_iter().any(|c| c.port == "jobs" && c.operation == "unschedule" && c.resource == "email-refresh-sweep");
    assert!(unscheduled, "the sweep stops itself when nothing is active");
}

#[test]
#[ignore = "Only through verify-gate"]
fn bad_requests_are_refused_before_anything_is_stored() {
    let f = Fixture::new();
    f.google(f.a, "code-bad");
    assert_eq!(f.route(f.a, "POST", "/email-refresh", json!({}), json!({})).0, 400);
    assert_eq!(f.route(f.a, "POST", "/email-refresh", json!({}), json!({"idempotencyKey":"not-a-uuid"})).0, 400);
    assert_eq!(f.status(f.a, "not-a-uuid").0, 400);
    assert_eq!(f.status(f.a, &Uuid::new_v4().to_string()).0, 404);
    assert!(f.mine(&["connector_email_refreshes"]).is_empty());
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_can_neither_read_nor_change_another_persons_refresh() {
    let f = Fixture::new();
    let google = f.google(f.a, "code-rls");
    let (_, body) = f.start(f.a, Uuid::new_v4());
    let id = body["refreshId"].as_str().unwrap().to_string();
    assert_eq!(f.status(f.b, &id).0, 404, "another person's refresh looks missing");
    // B has no eligible account, so B's own refresh is separate and A's is not joined.
    let mine = f.start(f.b, Uuid::new_v4()).1;
    assert_ne!(mine["refreshId"], json!(id));
    assert_eq!(f.status(f.b, mine["refreshId"].as_str().unwrap()).1["errorCode"], "no-eligible-accounts");
    // A job for A's refresh run as B does nothing.
    let params = json!({"account-id":google.to_string(),"refresh-id":id,"phase":"email-day","cursor":0,"calendar-upserted":0,"calendar-reconciled":0,"email-upserted":0,"email-failures":0,"trigger":"manual","recent-only":true,"error":"none","email-on":true,"calendar-on":false,"begun":false,"finishing":false});
    let job = json!({"queue":"email-refresh-google","parameters":params});
    let refused = f.call(f.b, "job", job.clone());
    assert_eq!(refused["outcome"], "skipped", "{refused}");
    let state = |f: &Fixture| f.mine(&["connector_email_refresh_accounts"]).into_iter().map(|a| a["status"].clone()).collect::<Vec<_>>();
    assert_eq!(state(&f), vec![json!("queued")], "A's account row is untouched");
    // With row-level security off on the refresh tables the same job reaches A's row, so the refusal above is the protection.
    let tables = ["connector_email_refreshes", "connector_email_refresh_keys", "connector_email_refresh_accounts"];
    for t in tables {
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE app.{t} NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.{t} DISABLE ROW LEVEL SECURITY"))).unwrap();
    }
    let open = f.call(f.b, "job", job);
    let after = state(&f);
    for t in tables {
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE app.{t} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{t} FORCE ROW LEVEL SECURITY"))).unwrap();
    }
    println!("RED without row security: {open} {after:?}");
    assert_ne!(after, vec![json!("queued")], "without the protection B's job changes A's row: {open}");
}
