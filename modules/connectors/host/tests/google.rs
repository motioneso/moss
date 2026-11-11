//! Google connect proofs: the real Rust package in WebAssembly, the real host and database,
//! and the fake Google. Run only through scripts/run-gate.sh (see tools/gate.ts).
use access_context::AccessContext;
use chrono::{Duration as Span, Utc};
use moss_connectors_host::{
    connector_cipher,
    google::{self, GoogleConfig, RefreshFailure},
    package, ConnectorsPorts,
};
use moss_module_host::runtime::{DenyPorts, Host, Limits};
use moss_standins::google::{GoogleConfig as FakeConfig, GoogleStandIn};
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const CLIENT_ID: &str = "fake-client-id.apps.example.com";
const CLIENT_SECRET: &str = "SENTINEL-CLIENT-SECRET-3c9e41";
/// What the fake Google hands out for its first grant.
const FIRST_ACCESS: &str = "ya29.fake-access-1";
const FIRST_REFRESH: &str = "1//fake-refresh-1";

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    db: Database,
    fake: GoogleStandIn,
    ports: Arc<ConnectorsPorts>,
    a: Uuid,
    b: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db, fake) = rt.block_on(async {
            let (root, c) =
                tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Google A',true),($2,$4,'Google B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            let fake = GoogleStandIn::start(FakeConfig {
                client_secret: CLIENT_SECRET.into(),
                ..FakeConfig::default()
            })
            .await;
            (root, db, fake)
        });
        let ports = Arc::new(
            ConnectorsPorts::new(db.clone(), Arc::new(DenyPorts), KEY)
                .unwrap()
                .with_google(config(&fake.token_url())),
        );
        Self { rt, root, db, fake, ports, a, b }
    }

    /// One request to the real package as `actor`.
    fn route(&self, actor: Uuid, method: &str, path: &str, id: Option<&str>, body: Value) -> (u64, Value) {
        let params = id.map(|id| json!({"id":id})).unwrap_or(json!({}));
        let request = json!({"method":method,"path":path,"params":params,"query":{},"body":body});
        let wasm = package::component(
            &std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("CONNECTORS_CORE_WASM")).unwrap(),
        )
        .unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(
                &wasm,
                Arc::new(package::manifest().unwrap()),
                AccessContext::new(actor, "google-proof"),
                self.ports.clone(),
                "route",
                &request.to_string(),
            )
            .unwrap();
        let reply: Value = serde_json::from_str(&out).unwrap();
        (reply["status"].as_u64().unwrap(), reply["body"].clone())
    }

    /// Starts a connection for `actor` and returns the pasted address Google would send back.
    fn authorize(&self, actor: Uuid, code: &str) -> (String, String) {
        self.fake.issue_code(code);
        let (status, body) = self.route(
            actor,
            "POST",
            "/google/authorize",
            None,
            json!({"clientId":CLIENT_ID,"clientSecret":CLIENT_SECRET}),
        );
        assert_eq!(status, 200, "{body}");
        let url = url::Url::parse(body["authUrl"].as_str().unwrap()).unwrap();
        let state = url.query_pairs().find(|(k, _)| k == "state").unwrap().1.to_string();
        (format!("http://localhost:1/?code={code}&state={state}"), state)
    }

    fn connect(&self, actor: Uuid, code: &str) -> Value {
        let (pasted, _) = self.authorize(actor, code);
        let (status, body) = self.route(actor, "POST", "/google/complete", None, json!({"redirectUrl":pasted}));
        assert_eq!(status, 201, "{body}");
        body["account"].clone()
    }

    fn stored_secret(&self, id: &str) -> Value {
        let id: Uuid = id.parse().unwrap();
        let sealed: Value = self
            .rt
            .block_on(self.root.query_one("SELECT encrypted_secret FROM app.connector_accounts WHERE id=$1", &[&id]))
            .unwrap()
            .get(0);
        let cipher = connector_cipher(KEY).unwrap();
        Value::Object(cipher.decrypt_json(&cipher.parse_envelope(&sealed).unwrap()).unwrap().value)
    }

    fn pending_count(&self, owner: Uuid) -> i64 {
        self.rt
            .block_on(self.root.query_one(
                "SELECT count(*) FROM app.connector_oauth_pending WHERE owner_user_id=$1",
                &[&owner],
            ))
            .unwrap()
            .get(0)
    }

    /// A token request through the host function itself, with a settable clock.
    fn token(&self, actor: Uuid, config: &GoogleConfig, force: bool) -> Result<String, RefreshFailure> {
        self.rt.block_on(async {
            let cx = DataContext::open(&self.db, &AccessContext::new(actor, "google-proof")).await.unwrap();
            let out = google::fresh_access_token(&cx, &connector_cipher(KEY).unwrap(), config, force)
                .await
                .unwrap();
            cx.commit().await.unwrap();
            out
        })
    }

    fn account(&self, actor: Uuid) -> Value {
        let (_, body) = self.route(actor, "GET", "/accounts", None, Value::Null);
        body["accounts"][0].clone()
    }
}

fn config(token_url: &str) -> GoogleConfig {
    GoogleConfig::test_only_loopback(token_url).unwrap()
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_person_connects_google_and_the_tokens_are_sealed() {
    let f = Fixture::new();
    let (pasted, _) = f.authorize(f.a, "code-connect");
    assert_eq!(f.pending_count(f.a), 1);
    let (status, body) = f.route(f.a, "POST", "/google/complete", None, json!({"redirectUrl":pasted}));
    assert_eq!(status, 201);
    let account = &body["account"];
    assert_eq!(account["providerId"], "google");
    assert_eq!(account["status"], "active");
    assert_eq!(account["hasSecret"], true);
    assert_eq!(account["scopes"], json!(["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/calendar.events"]));
    assert_eq!(f.pending_count(f.a), 0, "the pending sign-in is removed once used");
    let secret = f.stored_secret(account["id"].as_str().unwrap());
    assert_eq!(secret["kind"], "google-oauth");
    assert_eq!(secret["clientId"], CLIENT_ID);
    assert_eq!(secret["clientSecret"], CLIENT_SECRET);
    assert_eq!(secret["accessToken"], FIRST_ACCESS);
    assert_eq!(secret["refreshToken"], FIRST_REFRESH);
    assert!(secret["tokenExpiry"].as_str().unwrap().ends_with('Z'));
    // Connecting again replaces the sign-in on the same account.
    let again = f.connect(f.a, "code-again");
    assert_eq!(again["id"], account["id"]);
    let (_, list) = f.route(f.a, "GET", "/accounts", None, Value::Null);
    assert_eq!(list["accounts"].as_array().unwrap().len(), 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn refused_attempts_answer_like_the_old_server() {
    let f = Fixture::new();
    let complete = |actor, url: &str| f.route(actor, "POST", "/google/complete", None, json!({"redirectUrl":url}));
    // Nothing started yet.
    let (s, b) = complete(f.a, "http://localhost:1/?code=x&state=y");
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "No pending Google authorization found \u{2014} start the connect flow again"));
    // Started, but the address belongs to another attempt.
    let (pasted, _) = f.authorize(f.a, "code-refused");
    let (s, b) = complete(f.a, "http://localhost:1/?code=x&state=not-mine");
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "Authorization state did not match \u{2014} please retry the connect flow"));
    // Pastes the old server treated as plain failures.
    // These use the second person so the first stays under the five-a-minute limit.
    f.authorize(f.b, "code-bad");
    for bad in ["not a url", "http://localhost:1/?error=access_denied", "http://localhost:1/?code=only"] {
        let (s, b) = complete(f.b, bad);
        assert_eq!((s, b["error"].as_str().unwrap()), (500, "Internal server error"), "{bad}");
    }
    // A wrong code reaches Google and fails there. The pending sign-in survives for a retry.
    let wrong = pasted.replace("code=code-refused", "code=never-issued");
    let (s, b) = complete(f.a, &wrong);
    assert_eq!((s, b["error"].as_str().unwrap()), (500, "Internal server error"));
    assert_eq!(f.pending_count(f.a), 1);
    let (s, _) = complete(f.a, &pasted);
    assert_eq!(s, 201);
    // The second person has used three; the sixth finish inside a minute is refused.
    let mut last = (0, Value::Null);
    for _ in 0..3 {
        last = complete(f.b, "http://localhost:1/?code=x&state=y");
    }
    assert_eq!(last.0, 429);
    assert_eq!(last.1, json!({"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"}));
}

#[test]
#[ignore = "Only through verify-gate"]
fn tokens_refresh_near_expiry_share_one_request_and_a_revoked_grant_needs_sign_in() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-refresh")["id"].as_str().unwrap().to_string();
    let now = Arc::new(|| Utc::now());
    let soon = Arc::new(|| Utc::now() + Span::seconds(3600 - 30));
    let live = || config(&f.fake.token_url()).with_clock(now.clone());
    // Plenty of time left: the stored token is used and Google is not asked.
    assert_eq!(f.token(f.a, &live(), false), Ok(FIRST_ACCESS.into()));
    // Under a minute left: refreshed and stored.
    let near = config(&f.fake.token_url()).with_clock(soon);
    assert_eq!(f.token(f.a, &near, false), Ok("ya29.fake-access-2".into()));
    assert_eq!(f.stored_secret(&id)["accessToken"], "ya29.fake-access-2");
    assert_eq!(f.stored_secret(&id)["refreshToken"], FIRST_REFRESH);
    // Forcing refreshes even when time remains.
    assert_eq!(f.token(f.a, &live(), true), Ok("ya29.fake-access-3".into()));
    // Two callers at once share one request.
    let access = AccessContext::new(f.a, "google-proof");
    let expire = || {
        f.rt.block_on(f.root.execute(
            "UPDATE app.connector_accounts SET encrypted_secret = $2 WHERE id = $1",
            &[&id.parse::<Uuid>().unwrap(), &{
                let mut s = f.stored_secret(&id);
                s["tokenExpiry"] = json!("2000-01-01T00:00:00.000Z");
                connector_cipher(KEY).unwrap().encrypt_json(s.as_object().unwrap())
            }],
        ))
        .unwrap();
    };
    expire();
    let p = f.ports.clone();
    let (x, y) = std::thread::scope(|s| {
        let one = s.spawn(|| p.fresh_google_access_token(&access, false).unwrap());
        let two = s.spawn(|| p.fresh_google_access_token(&access, false).unwrap());
        (one.join().unwrap(), two.join().unwrap())
    });
    assert_eq!(x, y);
    assert_eq!(x, Ok("ya29.fake-access-4".into()), "a second request would have made access-5");
    // An unreachable Google leaves the account alone.
    let down = GoogleConfig::test_only_loopback("http://127.0.0.1:1/token").unwrap();
    assert_eq!(f.token(f.a, &down, true), Err(RefreshFailure::Unreachable));
    assert_eq!(f.account(f.a)["lastSyncError"], Value::Null);
    // A revoked grant marks the account as needing sign-in, with the old health label.
    f.fake.revoke_refresh_token(FIRST_REFRESH);
    assert_eq!(f.token(f.a, &live(), true), Err(RefreshFailure::NeedsSignIn));
    let account = f.account(f.a);
    assert_eq!(account["status"], "active");
    assert_eq!(account["lastSyncStatus"], "failed");
    assert_eq!(account["lastSyncError"], "auth-error");
    // No connection at all.
    assert_eq!(f.token(f.b, &live(), false), Err(RefreshFailure::NoConnection));
}

#[test]
#[ignore = "Only through verify-gate"]
fn google_accounts_revoke_and_stop_being_active() {
    let f = Fixture::new();
    let id = f.connect(f.a, "code-revoke")["id"].as_str().unwrap().to_string();
    let (s, b) = f.route(f.a, "POST", "/accounts/:id/revoke", Some(&id), Value::Null);
    assert_eq!(s, 200);
    assert_eq!(b["account"]["status"], "revoked");
    assert_eq!(f.token(f.a, &config(&f.fake.token_url()), false), Err(RefreshFailure::NoConnection));
    assert_eq!(f.stored_secret(&id), json!({"revoked":true}));
}

/// Everything the package or a browser could receive, for the sentinel search.
fn answers(f: &Fixture, id: &str) -> Vec<String> {
    let mut seen = vec![];
    for (method, path, id) in [
        ("GET", "/accounts", None),
        ("GET", "/providers", None),
        ("GET", "/admin/accounts", None),
        ("GET", "/accounts/:id/feature-grants", Some(id)),
    ] {
        seen.push(f.route(f.a, method, path, id, Value::Null).1.to_string());
    }
    seen.push(f.route(f.a, "POST", "/accounts/:id/revoke", Some(id), Value::Null).1.to_string());
    // The failure answers too.
    seen.push(f.route(f.a, "POST", "/google/complete", None, json!({"redirectUrl":"http://localhost:1/?code=x&state=y"})).1.to_string());
    seen
}

#[test]
#[ignore = "Only through verify-gate"]
fn no_answer_or_stored_plain_row_carries_the_client_secret_or_tokens() {
    let f = Fixture::new();
    f.fake.issue_code("code-sentinel");
    let (_, authorize_body) = f.route(
        f.a,
        "POST",
        "/google/authorize",
        None,
        json!({"clientId":CLIENT_ID,"clientSecret":CLIENT_SECRET}),
    );
    let state = url::Url::parse(authorize_body["authUrl"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .to_string();
    let pasted = format!("http://localhost:1/?code=code-sentinel&state={state}");
    // The pending row holds the client secret sealed, never in plain text.
    let pending: Value = f
        .rt
        .block_on(f.root.query_one(
            "SELECT to_jsonb(p) FROM app.connector_oauth_pending p WHERE owner_user_id=$1",
            &[&f.a],
        ))
        .unwrap()
        .get(0);
    let markers = [CLIENT_SECRET, FIRST_ACCESS, FIRST_REFRESH];
    assert!(!pending.to_string().contains(CLIENT_SECRET), "pending row holds the secret in plain text");
    let (_, complete) = f.route(f.a, "POST", "/google/complete", None, json!({"redirectUrl":pasted}));
    let id = complete["account"]["id"].as_str().unwrap().to_string();
    let row: Value = f
        .rt
        .block_on(f.root.query_one("SELECT to_jsonb(a) FROM app.connector_accounts a WHERE id=$1", &[&id.parse::<Uuid>().unwrap()]))
        .unwrap()
        .get(0);
    let mut seen = vec![row.to_string(), authorize_body.to_string(), complete.to_string()];
    seen.extend(answers(&f, &id));
    for text in &seen {
        for marker in markers {
            assert!(!text.contains(marker), "{marker} reached: {text}");
        }
    }
}

fn reach(f: &Fixture, victim_account: &str) -> Result<(), String> {
    // The second person starts a connection of their own and tries the first person's.
    f.authorize(f.b, "code-b");
    if f.pending_count(f.a) != 1 {
        return Err("starting a connection removed another person's pending sign-in".into());
    }
    let (s, _) = f.route(f.b, "POST", "/accounts/:id/revoke", Some(victim_account), Value::Null);
    if s != 404 {
        return Err(format!("another person revoked the connection ({s})"));
    }
    let (_, list) = f.route(f.b, "GET", "/accounts", None, Value::Null);
    if !list["accounts"].as_array().unwrap().is_empty() {
        return Err("another person saw the connection".into());
    }
    Ok(())
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_start_complete_or_revoke_another_persons_connection() {
    let f = Fixture::new();
    let mine = f.connect(f.a, "code-a1")["id"].as_str().unwrap().to_string();
    let (pasted, state) = f.authorize(f.a, "code-a2");
    // The second person cannot use the first person's pending state.
    let (s, b) = f.route(f.b, "POST", "/google/complete", None, json!({"redirectUrl":pasted}));
    assert_eq!(s, 400, "{b}");
    reach(&f, &mine).unwrap();
    // The first person is unaffected and can still finish.
    let (s, _) = f.route(f.a, "POST", "/google/complete", None, json!({"redirectUrl":pasted}));
    assert_eq!(s, 201);
    assert!(!state.is_empty());
    // Remove the protection, expect the same checks to fail, then restore it.
    let tables = ["app.connector_oauth_pending", "app.connector_accounts"];
    let (pasted, _) = f.authorize(f.a, "code-a3");
    for t in tables {
        f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {t} DISABLE ROW LEVEL SECURITY"))).unwrap();
    }
    let red = reach(&f, &mine);
    for t in tables {
        f.rt
            .block_on(f.root.batch_execute(&format!("ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; ALTER TABLE {t} FORCE ROW LEVEL SECURITY")))
            .unwrap();
    }
    println!("RED without row security: {red:?}");
    assert!(red.is_err(), "proof did not notice removed row-level security");
    let _ = pasted;
}

#[test]
fn the_test_only_google_address_must_be_on_this_machine() {
    for bad in ["https://oauth2.googleapis.com/token", "http://example.com/token", "ftp://127.0.0.1/token", "nonsense"] {
        assert!(GoogleConfig::test_only_loopback(bad).is_err(), "{bad}");
    }
    assert!(GoogleConfig::test_only_loopback("http://127.0.0.1:5200/token").is_ok());
}

#[test]
fn the_consent_address_matches_the_old_server() {
    let url = google::build_auth_url("cid.apps.example.com", "state-1");
    let fixtures: Value = serde_json::from_str(include_str!("google-fixtures.json")).unwrap();
    assert_eq!(url.as_str(), fixtures["authUrl"].as_str().unwrap());
    for case in fixtures["redirects"].as_array().unwrap() {
        let got = google::parse_redirect(case["input"].as_str().unwrap());
        match (&got, case["error"].as_str()) {
            (Ok((c, s)), None) => assert_eq!((c.as_str(), s.as_str()), (case["code"].as_str().unwrap(), case["state"].as_str().unwrap())),
            (Err(e), Some(m)) => assert_eq!(&e.to_string(), m),
            other => panic!("{case}: {other:?}"),
        }
    }
}
