//! The card and feedback routes on the real Rust server over HTTPS, with two real accounts.
//! Responses are never rewritten or intercepted. Run only through the proactive server gate.
use access_context::AccessContext;
use moss_module_host::proactive_cards::{self, Candidate, Placement};
use reqwest::Method;
use safety_core::db::{DataContext, Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use uuid::Uuid;

const MARKER: &str = "PLANTED-PRIVATE-TEXT-7c3e";

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Port(String);
impl Drop for Port {
    fn drop(&mut self) {
        let _ = Command::new("devports").args(["release", &self.0]).output();
    }
}
fn private(path: &Path, value: &Value) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(value.to_string().as_bytes()).unwrap();
}

#[test]
#[ignore = "Only through the proactive server gate"]
fn two_people_use_cards_and_feedback_on_the_real_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path();
    let port = Port(
        String::from_utf8(
            Command::new("devports")
                .args(["claim", &format!("js316-proactive-{}", std::process::id())])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .into(),
    );
    assert!(!port.0.is_empty());
    let origin = format!("https://localhost:{}", port.0);
    let cert = root.join("tls/certificate.pem");
    assert!(Command::new(std::env::var("JS170_CERTIFICATE").unwrap())
        .args(["local-certificate"])
        .arg(root.join("tls"))
        .arg(&origin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success());
    fs::create_dir(root.join("web")).unwrap();
    fs::write(
        root.join("web/index.html"),
        "<!doctype html><title>x</title>",
    )
    .unwrap();
    let app_url = std::env::var("JS43_APP_URL").unwrap();
    private(
        &root.join("credentials.json"),
        &json!({"app_url":app_url,"auth_url":std::env::var("JS170_AUTH_URL").unwrap(),"auth_secret":"temporary-disposable-proactive-signing-secret-316","connector_key":"ab".repeat(32)}),
    );
    private(
        &root.join("network.json"),
        &json!({"listen":format!("127.0.0.1:{}",port.0),"origins":[origin],"certificate":cert,"private_key":root.join("tls/key.pem"),"credentials":root.join("credentials.json")}),
    );
    let client = reqwest::blocking::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_pem(&fs::read(&cert).unwrap()).unwrap())
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let _server = Server(
        Command::new(std::env::var("JS170_SERVER").unwrap())
            .arg("serve")
            .arg("--instance")
            .arg(root)
            .arg("--web")
            .arg(root.join("web"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(root.join("server.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while !client
        .get(format!("{origin}/api/hello"))
        .send()
        .is_ok_and(|r| r.status().is_success())
    {
        assert!(
            Instant::now() < deadline,
            "server startup deadline\n{}",
            fs::read_to_string(root.join("server.log")).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(100));
    }

    // Setup allows one owner over HTTP, so the second person is made in the database with the
    // first person's password hash and then signs in through the real route.
    let password = "temporary-proactive-password-316-not-a-real-secret";
    let response = client
        .post(format!("{origin}/api/auth/sign-up/email"))
        .header("origin", &origin)
        .json(&json!({"name":"Ada","email":"ada@example.test","password":password}))
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    let ada_cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let ada: Uuid = response.json::<Value>().unwrap()["user"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let bootstrap = rt.block_on(async {
        let (db, conn) = tokio_postgres::connect(
            &std::env::var("JS43_BOOTSTRAP_URL").unwrap(),
            tokio_postgres::NoTls,
        )
        .await
        .unwrap();
        tokio::spawn(async move {
            let _ = conn.await;
        });
        db
    });
    let bob = Uuid::new_v4();
    rt.block_on(async {
        bootstrap
            .execute("INSERT INTO app.users (id, name, email, email_verified, created_at, updated_at, is_instance_admin, status) VALUES ($1, 'Bob', 'bob@example.test', false, now(), now(), false, 'active')", &[&bob])
            .await
            .unwrap();
        bootstrap
            .execute("INSERT INTO app.auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT gen_random_uuid(), $1::uuid::text, 'credential', $1::uuid, password, now(), now() FROM app.auth_accounts WHERE user_id = $2::uuid AND provider_id = 'credential'", &[&bob, &ada])
            .await
            .unwrap();
    });
    let signed = client
        .post(format!("{origin}/api/auth/sign-in/email"))
        .header("origin", &origin)
        .json(&json!({"email":"bob@example.test","password":password}))
        .send()
        .unwrap();
    assert_eq!(signed.status(), 200, "second person sign-in");
    let bob_cookie = signed.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    // Cards come from the real placement code, as a scanner would place them.
    rt.block_on(bootstrap.execute(
        "INSERT INTO app.preferences(owner_user_id,key,value_json)
         SELECT id,'quiet-hours','{\"enabled\":false,\"start\":\"22:00\",\"end\":\"08:00\",\"authority\":\"canonical\"}'::jsonb FROM app.users",
        &[],
    ))
    .unwrap();
    let database = rt
        .block_on(Database::connect(&app_url, 4, RuntimeRole::App))
        .unwrap();
    let now: String = rt
        .block_on(bootstrap.query_one(
            "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')",
            &[],
        ))
        .unwrap()
        .get(0);
    let card_id = rt.block_on(async {
        let cx = DataContext::open(&database, &AccessContext::new(ada, "proof"))
            .await
            .unwrap();
        let placed = proactive_cards::place(
            &cx,
            &Candidate {
                source: "email".into(),
                stable_key: "ada-private".into(),
                source_ref_hash: "hash-ada".into(),
                title: format!("Reply to {MARKER}"),
                summary: "A message from a client".into(),
                signal_type: "email_waiting".into(),
                priority_band: "high".into(),
                priority_reasons: json!(["waiting"]),
                target_at: None,
                expires_at: None,
            },
            &now,
        )
        .await
        .unwrap();
        cx.commit().await.unwrap();
        match placed {
            Placement::Placed { id, .. } => id,
            other => panic!("{other:?}"),
        }
    });

    let call = |cookie: Option<&str>, method: Method, path: &str, body: Option<Value>| {
        let mut request = client
            .request(method, format!("{origin}{path}"))
            .header("origin", &origin);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().unwrap();
        (
            response.status().as_u16(),
            response.json::<Value>().unwrap_or(Value::Null),
        )
    };
    let log = || fs::read_to_string(root.join("server.log")).unwrap_or_default();

    assert_eq!(
        call(None, Method::GET, "/api/me/proactive-cards", None).0,
        401,
        "signed out"
    );
    let (status, mine) = call(
        Some(&ada_cookie),
        Method::GET,
        "/api/me/proactive-cards",
        None,
    );
    assert_eq!(status, 200, "{mine}\n{}", log());
    assert_eq!(mine["cards"].as_array().unwrap().len(), 1);
    assert_eq!(mine["cards"][0]["id"], json!(card_id));
    let (_, theirs) = call(
        Some(&bob_cookie),
        Method::GET,
        "/api/me/proactive-cards",
        None,
    );
    assert_eq!(
        theirs["cards"].as_array().unwrap().len(),
        0,
        "Bob sees none of Ada's cards"
    );
    println!("PASS cards: Ada sees her own card, Bob sees none, signed-out is refused");

    let dismiss = json!({"targetKind":"proactive_card","targetRef":card_id.to_string(),"surface":"proactive","kind":"dismiss"});
    let (status, body) = call(
        Some(&bob_cookie),
        Method::POST,
        "/api/me/usefulness-feedback",
        Some(dismiss.clone()),
    );
    assert_eq!(status, 404, "Bob cannot act on Ada's card: {body}");
    let (status, body) = call(
        Some(&ada_cookie),
        Method::POST,
        "/api/me/usefulness-feedback",
        Some(dismiss),
    );
    assert_eq!(status, 201, "{body}\n{}", log());
    let signal_id = body["feedback"]["id"].as_str().unwrap().to_owned();
    let (_, after) = call(
        Some(&ada_cookie),
        Method::GET,
        "/api/me/proactive-cards",
        None,
    );
    assert_eq!(
        after["cards"].as_array().unwrap().len(),
        0,
        "dismissed card is gone"
    );
    let (_, listed) = call(
        Some(&ada_cookie),
        Method::GET,
        "/api/me/usefulness-feedback",
        None,
    );
    assert_eq!(listed["feedback"].as_array().unwrap().len(), 1);
    let (_, bobs) = call(
        Some(&bob_cookie),
        Method::GET,
        "/api/me/usefulness-feedback",
        None,
    );
    assert_eq!(
        bobs["feedback"].as_array().unwrap().len(),
        0,
        "Bob sees none of Ada's feedback"
    );
    let (status, _) = call(
        Some(&bob_cookie),
        Method::POST,
        &format!("/api/me/usefulness-feedback/{signal_id}/undo"),
        None,
    );
    assert_eq!(status, 404, "Bob cannot undo Ada's feedback");
    let (status, undone) = call(
        Some(&ada_cookie),
        Method::POST,
        &format!("/api/me/usefulness-feedback/{signal_id}/undo"),
        None,
    );
    assert_eq!(
        (status, undone["feedback"]["status"].as_str()),
        (200, Some("undone"))
    );
    let (_, back) = call(
        Some(&ada_cookie),
        Method::GET,
        "/api/me/proactive-cards",
        None,
    );
    assert_eq!(
        back["cards"].as_array().unwrap().len(),
        1,
        "undo brings the card back"
    );
    println!("PASS feedback: dismiss hides the card, undo restores it, Bob cannot see or touch Ada's feedback");

    let record = json!({"targetKind":"proactive_card","targetRef":card_id.to_string(),"surface":"proactive","kind":"too_much"});
    let (status, _) = call(
        Some(&ada_cookie),
        Method::POST,
        "/api/me/usefulness-feedback/signals",
        Some(record),
    );
    assert_eq!(status, 201);
    let (_, still) = call(
        Some(&ada_cookie),
        Method::GET,
        "/api/me/proactive-cards",
        None,
    );
    assert_eq!(
        still["cards"].as_array().unwrap().len(),
        1,
        "a signal changes no card"
    );
    let (status, refreshed) = call(
        Some(&ada_cookie),
        Method::POST,
        "/api/me/proactive-cards/refresh",
        None,
    );
    assert_eq!((status, refreshed["enqueued"].clone()), (202, json!(0)));
    let (status, bad) = call(
        Some(&ada_cookie),
        Method::PATCH,
        "/api/me/usefulness-feedback/not-a-uuid",
        Some(json!({"reason":"x"})),
    );
    assert_eq!(status, 400, "{bad}");
    println!("PASS signal changes no card; refresh answers 202; a bad id is refused with 400");

    let leaked = log().contains(MARKER);
    assert!(!leaked, "private card text reached the server log");
    println!("PASS privacy: the card text is absent from the server log");
    println!("NOT PROVEN: native UI, a second device, scanners placing cards (none are registered), the real job queue");
}
