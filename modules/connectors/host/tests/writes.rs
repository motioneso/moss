//! Write proofs: the real Rust package in WebAssembly, the real host and database, and the
//! stand-in Google, IMAP and SMTP servers. Email and Calendar are recorded stand-ins, so the
//! proof covers what leaves the package. Run only through scripts/run-gate.sh (see tools/gate.ts).
use access_context::AccessContext;
use moss_connectors_host::{
    google::GoogleConfig,
    imap::MailConfig,
    mail_probe::{Servers, Smtp},
    package, ConnectorsPorts,
};
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use moss_standins::{
    google::{GoogleConfig as FakeConfig, GoogleStandIn},
    mail::{MailConfig as StandInConfig, MailStandIn},
    tls::{self, Identity},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{sync::{Arc, Mutex}, time::Duration};
use tokio_postgres::{Client, NoTls};
use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer};
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const CLIENT_ID: &str = "fake-client-id.apps.example.com";
const CLIENT_SECRET: &str = "SENTINEL-CLIENT-SECRET-3c9e41";
const USER: &str = "bob@example.com";
const PASSWORD: &str = "SENTINEL-MAIL-PASSWORD-7f21c9";
const MODIFY: &str = "https://www.googleapis.com/auth/gmail.modify";
const CALENDAR: &str = "https://www.googleapis.com/auth/calendar";
/// Reply text that must reach the mail server and nothing else.
const BODY: &str = "SENTINEL-REPLY-BODY-5b02e8";

/// Everything the package sent to Email and Calendar, in order, with scripted answers.
#[derive(Default)]
struct Seen {
    calls: Mutex<Vec<(String, Value)>>,
    original: Mutex<Value>,
    events: Mutex<Vec<Value>>,
}

impl Ports for Seen {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let name = request.parameters["name"].as_str().unwrap_or(&request.operation).to_string();
        self.calls.lock().unwrap().push((name.clone(), request.parameters.clone()));
        Ok(match (port, name.as_str()) {
            ("context", "read") => json!({"now":"2026-03-02T08:00:00.000Z"}),
            ("api", "replyContext") => self.original.lock().unwrap().clone(),
            ("api", "listEvents") => json!({"events":*self.events.lock().unwrap()}),
            ("api", "getEvent") => {
                let id = request.parameters["parameters"]["id"].clone();
                let found = self.events.lock().unwrap().iter().find(|e| e["id"] == id).cloned();
                found.map_or(json!({}), |e| json!({"event":e}))
            }
            ("api", "upsertCachedEvent") => json!({"event":{"id":"cal-1"}}),
            ("api", "evictCachedEvent") => json!({"evicted":true}),
            _ => anyhow::bail!("unexpected {port}"),
        })
    }
}

impl Seen {
    fn named(&self, name: &str) -> Vec<Value> {
        self.calls.lock().unwrap().iter().filter(|c| c.0 == name).map(|c| c.1["parameters"].clone()).collect()
    }
    fn text(&self) -> String {
        serde_json::to_string(&*self.calls.lock().unwrap()).unwrap()
    }
}

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    google: GoogleStandIn,
    mail: MailStandIn,
    ports: Arc<ConnectorsPorts>,
    seen: Arc<Seen>,
    a: Uuid,
    b: Uuid,
}

fn der(id: &Identity) -> Vec<u8> {
    CertificateDer::from_pem_slice(id.cert_pem.as_bytes()).unwrap().to_vec()
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db, google, mail) = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Write A',true),($2,$4,'Write B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App).await.unwrap();
            let google = GoogleStandIn::start(FakeConfig { client_secret: CLIENT_SECRET.into(), ..FakeConfig::default() }).await;
            let mail = MailStandIn::start(StandInConfig { username: USER.into(), password: PASSWORD.into(), tls: Some(&tls::SELF_SIGNED) }).await;
            (root, db, google, mail)
        });
        let seen = Arc::new(Seen::default());
        let servers = Servers {
            imap_host: "127.0.0.1".into(),
            imap_port: mail.imap_addr.port(),
            imap_tls: true,
            smtp_host: "127.0.0.1".into(),
            smtp_port: mail.smtp_addr.port(),
            smtp_security: Smtp::ImplicitTls,
        };
        let config = GoogleConfig::test_only_loopback(&google.token_url()).unwrap().with_retry_delay(Duration::from_millis(5));
        let ports = Arc::new(
            ConnectorsPorts::new(db, seen.clone(), KEY)
                .unwrap()
                .with_google(config)
                .with_mail(MailConfig::test_only_loopback(servers, vec![der(&tls::SELF_SIGNED)]).unwrap()),
        );
        Self { rt, root, google, mail, ports, seen, a, b }
    }

    fn call(&self, actor: Uuid, entry: &str, payload: Value) -> Value {
        let wasm = package::component(&std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("CONNECTORS_CORE_WASM")).unwrap()).unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(&wasm, Arc::new(package::manifest().unwrap()), AccessContext::new(actor, "write-proof"), self.ports.clone(), entry, &payload.to_string())
            .unwrap();
        serde_json::from_str(&out).unwrap()
    }

    fn route(&self, actor: Uuid, method: &str, path: &str, body: Value) -> (u64, Value) {
        let reply = self.call(actor, "route", json!({"method":method,"path":path,"params":{},"query":{},"body":body}));
        (reply["status"].as_u64().unwrap(), reply["body"].clone())
    }

    fn connect_google(&self, actor: Uuid, code: &str) -> Uuid {
        self.google.issue_code(code);
        let (status, body) = self.route(actor, "POST", "/google/authorize", json!({"clientId":CLIENT_ID,"clientSecret":CLIENT_SECRET}));
        assert_eq!(status, 200, "{body}");
        let url = url::Url::parse(body["authUrl"].as_str().unwrap()).unwrap();
        let state = url.query_pairs().find(|(k, _)| k == "state").unwrap().1.to_string();
        let (status, body) = self.route(actor, "POST", "/google/complete", json!({"redirectUrl":format!("http://localhost:1/?code={code}&state={state}")}));
        assert_eq!(status, 201, "{body}");
        let id: Uuid = body["account"]["id"].as_str().unwrap().parse().unwrap();
        self.rt
            .block_on(self.root.execute("UPDATE app.connector_accounts SET scopes=$2 WHERE id=$1", &[&id, &vec![MODIFY.to_string(), CALENDAR.to_string()]]))
            .unwrap();
        id
    }

    fn connect_mail(&self, actor: Uuid) -> Uuid {
        let (status, body) = self.route(actor, "POST", "/imap/connect", json!({"providerId":"imap-fastmail","username":USER,"password":PASSWORD}));
        assert_eq!(status, 201, "{body}");
        body["account"]["id"].as_str().unwrap().parse().unwrap()
    }

    fn original(&self, account: Uuid, thread: Value) {
        *self.seen.original.lock().unwrap() = json!({
            "accountId":account.to_string(),"sender":"Ann Lee <ann@example.com>","subject":"Lunch?",
            "threadId":thread,"messageId":"m3@x","references":["m1@x","m2@x"]});
    }

    /// Prepares the card, then runs the tool with the version it showed, as an approval would.
    fn reply(&self, actor: Uuid, tool: &str) -> Value {
        self.reply_approved_by(actor, actor, tool)
    }

    /// The approval was shown to `approver`, but `actor` runs the tool with its version.
    fn reply_approved_by(&self, approver: Uuid, actor: Uuid, tool: &str) -> Value {
        let parameters = json!({"cacheMessageId":"c1","body":BODY});
        let card = self.call(approver, "api", json!({"name":"prepareEmailAction","parameters":parameters}));
        let version = card["version"].clone();
        let out = self.call(actor, "tool", json!({"tool":tool,"parameters":parameters,"approvalVersion":version}));
        out["data"].clone()
    }

    fn tool(&self, actor: Uuid, tool: &str, parameters: Value) -> Value {
        self.call(actor, "tool", json!({"tool":tool,"parameters":parameters}))
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_google_reply_is_sent_once_on_the_thread_and_the_text_goes_nowhere_else() {
    let f = Fixture::new();
    let id = f.connect_google(f.a, "code-send");
    f.original(id, json!("t-9"));
    let out = f.reply(f.a, "email.sendReply");
    assert_eq!(out, json!({"ok":true,"mode":"sent"}), "{out} {:?}", f.google.requests());
    let sent = f.google.sent();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains("To: Ann Lee <ann@example.com>") && sent[0].contains("Subject: Re: Lunch?"));
    assert!(sent[0].contains("In-Reply-To: <m3@x>") && sent[0].contains("References: <m1@x> <m2@x> <m3@x>"));
    assert!(sent[0].contains(BODY));
    let posts: Vec<_> = f.google.requests().into_iter().filter(|r| r.contains("messages/send")).collect();
    assert_eq!(posts.len(), 1, "sent exactly once: {posts:?}");
    assert!(!f.seen.text().contains(BODY), "the reply text never reaches Email, Calendar or the queue");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_google_draft_is_saved_on_the_thread_and_nothing_is_sent() {
    let f = Fixture::new();
    let id = f.connect_google(f.a, "code-draft");
    f.original(id, json!("t-9"));
    let out = f.reply(f.a, "email.draftReply");
    assert_eq!(out, json!({"ok":true,"mode":"drafted"}), "{out} {:?}", f.google.requests());
    let drafts = f.google.drafts();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].1.as_deref(), Some("t-9"));
    assert!(drafts[0].0.contains(BODY));
    assert!(f.google.sent().is_empty());
}

#[test]
#[ignore = "Only through verify-gate"]
fn an_imap_reply_goes_out_by_smtp_and_a_copy_is_filed_in_sent() {
    let f = Fixture::new();
    let id = f.connect_mail(f.a);
    f.original(id, Value::Null);
    let out = f.reply(f.a, "email.sendReply");
    assert_eq!(out, json!({"ok":true,"mode":"sent"}), "{out} {:?}", f.google.requests());
    let sent = f.mail.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].from, USER);
    assert_eq!(sent[0].recipients, vec!["ann@example.com".to_string()]);
    assert!(sent[0].data.contains(&format!("From: {USER}")) && sent[0].data.contains("In-Reply-To: <m3@x>") && sent[0].data.contains(BODY));
    let filed = f.mail.folder_messages("Sent");
    assert_eq!(filed.len(), 1);
    assert!(filed[0].0.contains(BODY));
    assert!(!f.seen.text().contains(BODY));
}

#[test]
#[ignore = "Only through verify-gate"]
fn an_imap_draft_lands_in_drafts_and_is_never_sent() {
    let f = Fixture::new();
    let id = f.connect_mail(f.a);
    f.original(id, Value::Null);
    assert_eq!(f.reply(f.a, "email.draftReply"), json!({"ok":true,"mode":"drafted"}));
    assert!(f.mail.sent().is_empty());
    let drafts = f.mail.folder_messages("Drafts");
    assert_eq!(drafts.len(), 1);
    assert!(drafts[0].1.iter().any(|flag| flag == "\\Draft"), "{:?}", drafts[0].1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_send_or_draft_through_another_persons_account() {
    let f = Fixture::new();
    let id = f.connect_google(f.a, "code-rls");
    f.original(id, json!("t-9"));
    let before = f.google.requests().len();
    // The second person asks for the first person's message and account.
    let out = f.reply_approved_by(f.a, f.b, "email.sendReply");
    assert_eq!(out["ok"], false, "{out}");
    let out = f.tool(f.b, "email.draftReply", json!({"cacheMessageId":"c1","body":BODY}));
    assert_eq!(out["data"]["ok"], false, "{out}");
    assert_eq!(f.google.requests().len(), before, "no Google call is made for someone else's account");
    assert!(f.google.sent().is_empty() && f.google.drafts().is_empty());
    // With row-level security off the same call reaches the account, so the refusal above is the protection.
    // Other tests leave accounts behind, and the token lookup takes the only visible active one.
    f.rt.block_on(f.root.execute("UPDATE app.connector_accounts SET status='error' WHERE id <> $1", &[&id])).unwrap();
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.connector_accounts NO FORCE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts DISABLE ROW LEVEL SECURITY")).unwrap();
    let open = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.reply_approved_by(f.a, f.b, "email.sendReply")));
    f.rt.block_on(f.root.batch_execute("ALTER TABLE app.connector_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE app.connector_accounts FORCE ROW LEVEL SECURITY")).unwrap();
    let open = open.expect("the send ran");
    assert_eq!(open["ok"], true, "without the protection the foreign send lands: {open}");
    assert_eq!(f.google.sent().len(), 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn calendar_writes_land_in_google_and_in_calendar_and_skip_busy_time() {
    let f = Fixture::new();
    f.connect_google(f.a, "code-cal");
    f.google.add_event("Standup", "2026-03-03T09:00:00Z", "2026-03-03T10:00:00Z");
    let created = f.call(f.a, "api", json!({"name":"createCalendarEvent","parameters":{
        "windowStart":"2026-03-03T09:00:00Z","windowEnd":"2026-03-03T12:00:00Z","durationMinutes":60,"title":"Focus time"}}));
    assert_eq!(created["created"], true, "{created}");
    assert_eq!(created["resolvedStart"], "2026-03-03T10:00:00.000Z", "shifted past the busy hour: {created}");
    assert_eq!(created["shifted"], true);
    let made = f.google.events().into_iter().find(|e| e["summary"] == "Focus time").expect("created in Google");
    assert!(made["id"].as_str().unwrap().starts_with("jfb"));
    assert_eq!(f.seen.named("upsertCachedEvent").len(), 1, "mirrored into Calendar");
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_write_to_another_persons_calendar() {
    let f = Fixture::new();
    f.connect_google(f.a, "code-cal-rls");
    let before = f.google.requests().len();
    let out = f.call(f.b, "api", json!({"name":"createCalendarEvent","parameters":{
        "windowStart":"2026-03-03T09:00:00Z","windowEnd":"2026-03-03T12:00:00Z","durationMinutes":60,"title":"Intrusion"}}));
    assert_eq!(out["created"], false, "{out}");
    assert_eq!(f.google.requests().len(), before);
    assert!(f.google.events().iter().all(|e| e["summary"] != "Intrusion"));
}
