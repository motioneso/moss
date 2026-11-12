//! Google sync proofs: the real Rust package in WebAssembly, the real host and database, and
//! the fake Google. Calendar, Email and the job queue are recorded stand-ins, so the proof
//! covers what leaves the package. Run only through scripts/run-gate.sh (see tools/gate.ts).
use access_context::AccessContext;
use moss_connectors_host::{package, ConnectorsPorts};
use moss_connectors_host::google::GoogleConfig;
use moss_module_host::runtime::{CallScope, DenyPorts, Host, Limits, Ports, Request};
use moss_standins::google::{GoogleConfig as FakeConfig, GoogleStandIn};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{sync::{Arc, Mutex}, time::Duration};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const CLIENT_ID: &str = "fake-client-id.apps.example.com";
const CLIENT_SECRET: &str = "SENTINEL-CLIENT-SECRET-3c9e41";
const ACCESS: &str = "ya29.fake-access-1";
const REFRESH: &str = "1//fake-refresh-1";
/// Longer than the 100-character snippet, so the sentinel after it is body text only.
const PAD: &str = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam";
const BODY_TEXT: &str = "SENTINEL-MAIL-BODY-text-9d41";
const MODIFY: &str = "https://www.googleapis.com/auth/gmail.modify";
const CALENDAR: &str = "https://www.googleapis.com/auth/calendar";

/// Everything the package sent to Calendar, Email and the queue, in order.
#[derive(Default)]
struct Seen(Mutex<Vec<(String, String, Value)>>);

impl Ports for Seen {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let name = request.parameters["name"].as_str().unwrap_or(&request.operation).to_string();
        self.0.lock().unwrap().push((port.into(), name.clone(), request.parameters.clone()));
        Ok(match (port, name.as_str()) {
            ("context", "read") => json!({"now":"2026-01-01T00:00:00.000Z"}),
            ("context", _) => json!({"id":Uuid::new_v4().to_string()}),
            ("jobs", _) => json!({"id":"row-1"}),
            ("api", "listCachedMessageKeys") => json!({"keys":[]}),
            ("api", "pruneCachedEvents") => json!({"deleted":0}),
            ("api", _) => json!({}),
            _ => anyhow::bail!("unexpected {port}"),
        })
    }
}

impl Seen {
    fn named(&self, name: &str) -> Vec<Value> {
        let all = self.0.lock().unwrap();
        let inner = |p: &Value| if p["parameters"].is_object() { p["parameters"].clone() } else { p.clone() };
        all.iter().filter(|c| c.1 == name).map(|c| inner(&c.2)).collect()
    }
    fn text(&self) -> String {
        serde_json::to_string(&*self.0.lock().unwrap()).unwrap()
    }
    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    fake: GoogleStandIn,
    ports: Arc<ConnectorsPorts>,
    seen: Arc<Seen>,
    a: Uuid,
    b: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db, fake) = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Sync A',true),($2,$4,'Sync B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App).await.unwrap();
            let fake = GoogleStandIn::start(FakeConfig { client_secret: CLIENT_SECRET.into(), ..FakeConfig::default() }).await;
            (root, db, fake)
        });
        let seen = Arc::new(Seen::default());
        let config = GoogleConfig::test_only_loopback(&fake.token_url()).unwrap().with_retry_delay(Duration::from_millis(5));
        let ports = Arc::new(ConnectorsPorts::new(db, seen.clone(), KEY).unwrap().with_google(config));
        let _ = DenyPorts;
        Self { rt, root, fake, ports, seen, a, b }
    }

    fn call(&self, actor: Uuid, entry: &str, payload: Value) -> Value {
        let wasm = package::component(&std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("CONNECTORS_CORE_WASM")).unwrap()).unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(&wasm, Arc::new(package::manifest().unwrap()), AccessContext::new(actor, "sync-proof"), self.ports.clone(), entry, &payload.to_string())
            .unwrap();
        serde_json::from_str(&out).unwrap()
    }

    fn route(&self, actor: Uuid, method: &str, path: &str, body: Value) -> (u64, Value) {
        let request = json!({"method":method,"path":path,"params":{},"query":{},"body":body});
        let reply = self.call(actor, "route", request);
        (reply["status"].as_u64().unwrap(), reply["body"].clone())
    }

    /// Connects Google for `actor` through the real route, then gives the account the scopes a real grant has.
    fn connect(&self, actor: Uuid, code: &str) -> Uuid {
        self.fake.issue_code(code);
        let (status, body) = self.route(actor, "POST", "/google/authorize", json!({"clientId":CLIENT_ID,"clientSecret":CLIENT_SECRET}));
        assert_eq!(status, 200, "{body}");
        let url = url::Url::parse(body["authUrl"].as_str().unwrap()).unwrap();
        let state = url.query_pairs().find(|(k, _)| k == "state").unwrap().1.to_string();
        let pasted = format!("http://localhost:1/?code={code}&state={state}");
        let (status, body) = self.route(actor, "POST", "/google/complete", json!({"redirectUrl":pasted}));
        assert_eq!(status, 201, "{body}");
        let id: Uuid = body["account"]["id"].as_str().unwrap().parse().unwrap();
        self.rt
            .block_on(self.root.execute("UPDATE app.connector_accounts SET scopes=$2 WHERE id=$1", &[&id, &vec![MODIFY.to_string(), CALENDAR.to_string()]]))
            .unwrap();
        self.seen.clear();
        id
    }

    fn job_params(id: Uuid, phase: &str, recent_only: bool) -> Value {
        json!({
            "account-id":id.to_string(),"phase":phase,"cursor":0,"calendar-upserted":0,
            "calendar-reconciled":0,"email-upserted":0,"email-failures":0,"trigger":"manual",
            "recent-only":recent_only,"error":"none","email-on":true,"calendar-on":true,
        })
    }

    fn job(&self, actor: Uuid, params: Value) -> Value {
        self.call(actor, "job", json!({"queue":"google-sync","parameters":params}))
    }

    /// The job the package queued last, as its parameters.
    fn last_queued(&self) -> Value {
        let all = self.seen.0.lock().unwrap();
        let entry = all.iter().rev().find(|c| c.0 == "jobs" && c.1 == "enqueue-options").expect("a queued job");
        entry.2["params"].clone()
    }

    /// Runs a whole sync, following every job the package hands on to a new one.
    fn sync(&self, actor: Uuid, id: Uuid, recent_only: bool) -> Value {
        let mut outcome = self.job(actor, Self::job_params(id, "calendar", recent_only));
        for _ in 0..200 {
            if outcome["outcome"] != "continued" {
                break;
            }
            outcome = self.job(actor, self.last_queued());
        }
        outcome
    }

    fn row(&self, id: Uuid) -> Value {
        self.rt
            .block_on(self.root.query_one("SELECT to_jsonb(a) FROM app.connector_accounts a WHERE id=$1", &[&id]))
            .unwrap()
            .get(0)
    }

    fn add_event(&self, title: &str) {
        let client = reqwest::blocking::Client::new();
        let reply = client
            .post(format!("{}/calendar/v3/calendars/primary/events", self.fake.base_url()))
            .bearer_auth(ACCESS)
            .json(&json!({"summary":title,"start":{"dateTime":"2026-01-02T10:00:00Z"},"end":{"dateTime":"2026-01-02T11:00:00Z"}}))
            .send()
            .unwrap();
        assert!(reply.status().is_success());
    }

    fn mail(&self, subject: &str) -> String {
        let raw = format!("From: Alice <alice@example.com>\r\nTo: bob@example.com\r\nSubject: {subject}\r\nMessage-ID: <{subject}@example.com>\r\nContent-Type: text/plain\r\n\r\n{PAD} {BODY_TEXT}");
        self.fake.add_message(&raw, &["INBOX"])
    }
}

fn externals(calls: &[Value]) -> Vec<String> {
    calls.iter().map(|c| c["externalId"].as_str().unwrap().to_string()).collect()
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_full_walk_writes_every_event_and_message_and_keeps_secrets_out_of_everything() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-walk");
    f.add_event("Planning");
    f.add_event("Review");
    let one = f.mail("one");
    let two = f.mail("two");
    assert_eq!(f.sync(f.a, id, false)["outcome"], "done");
    assert_eq!(f.seen.named("upsertCachedEvent").len(), 2);
    assert_eq!(f.seen.named("pruneCachedEvents").len(), 1);
    let mut inserted = externals(&f.seen.named("insertCachedMessage"));
    inserted.sort();
    inserted.dedup();
    let mut want = vec![one, two];
    want.sort();
    assert_eq!(inserted, want, "both messages are saved (Email's insert is an upsert, so the day and full phases may repeat one)");
    let row = f.row(id);
    assert_eq!(row["last_sync_status"], "success");
    assert_eq!(row["last_sync_counts"]["calendarUpserted"], 2);
    assert!(row["email_history_id"].is_string(), "the Gmail position is saved after a full success");
    // No token, client secret or mail body text reaches anything the package sent or the account row.
    let everything = format!("{} {}", f.seen.text(), row);
    for secret in [ACCESS, REFRESH, CLIENT_SECRET] {
        assert!(!everything.contains(secret), "{secret} leaked");
    }
    assert!(!f.seen.text().contains(BODY_TEXT), "message text beyond the snippet never travels");
    for (port, _, params) in f.seen.0.lock().unwrap().iter().filter(|c| c.0 == "jobs") {
        assert!(params.to_string().len() < 1500, "{port}: job payloads stay small");
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_run_reads_only_what_changed_and_survives_a_deleted_message() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-history");
    let keep = f.mail("keep");
    let gone = f.mail("gone");
    assert_eq!(f.sync(f.a, id, false)["outcome"], "done");
    f.seen.clear();
    f.fake.add_label(&keep, "STARRED");
    f.fake.delete_message(&gone);
    let late = f.mail("late");
    assert_eq!(f.sync(f.a, id, false)["outcome"], "done");
    let mut inserted = externals(&f.seen.named("insertCachedMessage"));
    inserted.sort();
    let mut want = vec![keep, late];
    want.sort();
    assert_eq!(inserted, want, "the changed and the new message are written, the deleted one is skipped");
    assert_eq!(f.row(id)["last_sync_status"], "success");
    assert!(f.fake.requests().iter().any(|r| r.contains("history")), "the second run used the saved position");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_can_neither_start_nor_read_through_another_persons_account() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-rls");
    f.mail("private");
    let before = f.fake.requests().len();
    let outcome = f.sync(f.b, id, false);
    assert_eq!(outcome["outcome"], "inactive", "{outcome}");
    assert_eq!(f.fake.requests().len(), before, "no Google call is made for someone else's account");
    assert!(f.seen.named("insertCachedMessage").is_empty());
    assert!(f.row(id)["last_sync_started_at"].is_null(), "the owner's row is untouched");
    // The chunk and finish calls are refused the same way when made directly as the second person.
    let mut calendar = Fixture::job_params(id, "calendar", false);
    calendar["begun"] = json!(true);
    let mut mail = Fixture::job_params(id, "email-day", false);
    mail["begun"] = json!(true);
    let mut finishing = Fixture::job_params(id, "calendar", false);
    finishing["begun"] = json!(true);
    finishing["finishing"] = json!(true);
    finishing["error"] = json!("email-error");
    for (name, params) in [("calendar", calendar.clone()), ("list", mail.clone())] {
        assert_eq!(f.job(f.b, params)["outcome"], "inactive", "{name}");
    }
    f.job(f.b, finishing.clone());
    assert!(f.row(id)["last_sync_status"].is_null(), "the owner's row is untouched by a foreign finish");
    assert_eq!(f.fake.requests().len(), before, "no Google call is made for someone else's account");
    assert!(f.seen.named("upsertCachedEvent").is_empty() && f.seen.named("insertCachedMessage").is_empty());
    // With row-level security off the same calls reach the row, so the refusals above come from the protection.
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.connector_accounts NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = f.job(f.b, finishing);
    let after = f.row(id);
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.connector_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts FORCE ROW LEVEL SECURITY")).unwrap();
    assert_eq!(open["outcome"], "done", "{open}");
    assert_eq!(after["last_sync_status"], "failed", "without the protection the foreign finish lands: {after}");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_long_walk_keeps_its_claim_and_a_newer_start_is_refused() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-long");
    for n in 0..3 {
        f.mail(&format!("m{n}"));
    }
    let first = f.job(f.a, Fixture::job_params(id, "calendar", false));
    assert_eq!(first["outcome"], "continued", "{first}");
    // The start is old, as in a walk that has run for a long time.
    f.rt.block_on(f.root.execute("UPDATE app.connector_accounts SET last_sync_started_at = now() - interval '900 seconds' WHERE id=$1", &[&id])).unwrap();
    let next = f.job(f.a, f.last_queued());
    assert_eq!(next["outcome"], "continued", "{next}");
    // A chunk refreshes the claim, so the schedule's start finds the account busy.
    let rival = f.job(f.a, Fixture::job_params(id, "calendar", false));
    assert_eq!(rival["outcome"], "busy", "{rival}");
}

#[test]
#[ignore = "Only through verify-gate"]
fn transient_refusals_are_retried_and_a_stubborn_one_is_recorded_without_google_text() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-retry");
    f.add_event("Retried");
    f.fake.rate_limit_next(2);
    assert_eq!(f.sync(f.a, id, false)["outcome"], "done");
    assert_eq!(f.row(id)["last_sync_status"], "success", "two refusals then success");
    assert_eq!(f.seen.named("upsertCachedEvent").len(), 1);
    f.seen.clear();
    f.fake.rate_limit_next(50);
    f.sync(f.a, id, false);
    let row = f.row(id);
    assert_eq!(row["last_sync_status"], "partial", "the first error was in Calendar");
    let detail = &row["last_sync_counts"]["emailErrorDetail"];
    assert_eq!(detail["status"], 429);
    assert!(detail["operation"].is_string());
    let text = row["last_sync_counts"].to_string();
    assert!(!text.contains("Rate Limit") && !text.contains("message"), "{text}");
    assert!(f.seen.named("pruneCachedEvents").is_empty(), "a failed walk never prunes");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_revoked_sign_in_fails_the_run_and_a_second_start_is_refused_while_one_is_going() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-auth");
    f.fake.revoke_refresh_token(REFRESH);
    f.fake.expire_access_token(ACCESS);
    f.sync(f.a, id, false);
    let row = f.row(id);
    assert_eq!((row["last_sync_status"].clone(), row["last_sync_error"].clone()), (json!("failed"), json!("auth-error")));
    // A run that never finished blocks the next start for a while.
    f.rt.block_on(f.root.execute("UPDATE app.connector_accounts SET last_sync_status=NULL, last_sync_started_at=now() WHERE id=$1", &[&id])).unwrap();
    assert_eq!(f.sync(f.a, id, false)["outcome"], "busy");
}
