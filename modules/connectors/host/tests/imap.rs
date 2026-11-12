//! Mail connect proofs: the real Rust package in WebAssembly, the real host and database,
//! and the stand-in IMAP and SMTP servers. Run only through scripts/run-gate.sh (see tools/gate.ts).
use access_context::AccessContext;
use moss_connectors_host::{
    connector_cipher,
    imap::MailConfig,
    mail_probe::{Servers, Smtp},
    package, ConnectorsPorts,
};
use moss_module_host::runtime::{DenyPorts, Host, Limits};
use moss_standins::{
    mail::{MailConfig as StandInConfig, MailStandIn},
    tls::{self, Identity},
};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_postgres::{Client, NoTls};
use tokio_rustls::rustls::pki_types::{pem::PemObject, CertificateDer};
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const USER: &str = "bob@example.com";
const PASSWORD: &str = "SENTINEL-MAIL-PASSWORD-7f21c9";

struct Fixture {
    rt: tokio::runtime::Runtime,
    root: Client,
    mail: MailStandIn,
    ports: Arc<ConnectorsPorts>,
    a: Uuid,
    b: Uuid,
}

fn der(id: &Identity) -> Vec<u8> {
    CertificateDer::from_pem_slice(id.cert_pem.as_bytes()).unwrap().to_vec()
}

fn servers(mail: &MailStandIn) -> Servers {
    Servers {
        imap_host: "127.0.0.1".into(),
        imap_port: mail.imap_addr.port(),
        imap_tls: true,
        smtp_host: "127.0.0.1".into(),
        smtp_port: mail.smtp_addr.port(),
        smtp_security: Smtp::ImplicitTls,
    }
}

impl Fixture {
    /// `trusted` lists the certificates the login test accepts.
    fn new(trusted: Vec<Vec<u8>>) -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (root, db, mail) = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls)
                .await
                .unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute(
                "INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$3,'Mail A',true),($2,$4,'Mail B',false)",
                &[&a, &b, &format!("{a}@example.test"), &format!("{b}@example.test")],
            )
            .await
            .unwrap();
            let db = Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App)
                .await
                .unwrap();
            let mail = MailStandIn::start(StandInConfig {
                username: USER.into(),
                password: PASSWORD.into(),
                tls: Some(&tls::SELF_SIGNED),
            })
            .await;
            (root, db, mail)
        });
        let config = MailConfig::test_only_loopback(servers(&mail), trusted).unwrap();
        let ports = Arc::new(ConnectorsPorts::new(db, Arc::new(DenyPorts), KEY).unwrap().with_mail(config));
        Self { rt, root, mail, ports, a, b }
    }

    fn trusting() -> Self {
        Self::new(vec![der(&tls::SELF_SIGNED)])
    }

    fn route(&self, actor: Uuid, method: &str, path: &str, body: Value) -> (u64, Value) {
        let request = json!({"method":method,"path":path,"params":{},"query":{},"body":body});
        let wasm = package::component(
            &std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("CONNECTORS_CORE_WASM")).unwrap(),
        )
        .unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(
                &wasm,
                Arc::new(package::manifest().unwrap()),
                AccessContext::new(actor, "mail-proof"),
                self.ports.clone(),
                "route",
                &request.to_string(),
            )
            .unwrap();
        let reply: Value = serde_json::from_str(&out).unwrap();
        (reply["status"].as_u64().unwrap(), reply["body"].clone())
    }

    fn connect(&self, actor: Uuid, provider: &str, password: &str) -> (u64, Value) {
        self.route(actor, "POST", "/imap/connect", json!({"providerId":provider,"username":USER,"password":password}))
    }

    fn rows(&self, owner: Uuid) -> Vec<Value> {
        self.rt
            .block_on(self.root.query(
                "SELECT to_jsonb(a) FROM app.connector_accounts a WHERE owner_user_id=$1 AND provider_id LIKE 'imap-%'",
                &[&owner],
            ))
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect()
    }

    fn secret(&self, id: &str) -> Value {
        let sealed: Value = self
            .rt
            .block_on(self.root.query_one(
                "SELECT encrypted_secret FROM app.connector_accounts WHERE id=$1",
                &[&id.parse::<Uuid>().unwrap()],
            ))
            .unwrap()
            .get(0);
        let cipher = connector_cipher(KEY).unwrap();
        Value::Object(cipher.decrypt_json(&cipher.parse_envelope(&sealed).unwrap()).unwrap().value)
    }
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_person_connects_mail_and_the_password_is_sealed_with_the_preset_servers() {
    let f = Fixture::trusting();
    let (status, body) = f.connect(f.a, "imap-fastmail", PASSWORD);
    assert_eq!(status, 201, "{body}");
    let account = &body["account"];
    assert_eq!(account["providerId"], "imap-fastmail");
    assert_eq!(account["status"], "active");
    assert_eq!(account["hasSecret"], true);
    assert_eq!(account["scopes"], json!(["email.read"]));
    let secret = f.secret(account["id"].as_str().unwrap());
    // The servers come from the preset even though the test reached a stand-in.
    assert_eq!(
        secret,
        json!({"kind":"imap-password","providerId":"imap-fastmail","username":USER,"password":PASSWORD,
               "imapHost":"imap.fastmail.com","imapPort":993,"imapTls":true,
               "smtpHost":"smtp.fastmail.com","smtpPort":465,"smtpSecurity":"implicit_tls"})
    );
    // Connecting again updates the same account.
    let (status, again) = f.connect(f.a, "imap-fastmail", PASSWORD);
    assert_eq!(status, 201);
    assert_eq!(again["account"]["id"], account["id"]);
    assert_eq!(f.rows(f.a).len(), 1);
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_failed_connect_answers_like_the_old_server_and_saves_nothing() {
    let f = Fixture::trusting();
    let (s, b) = f.connect(f.a, "imap-yahoo", "wrong-password");
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "The mail server rejected the supplied username/password"));
    let strict = Fixture::new(vec![]);
    let (s, b) = strict.connect(strict.a, "imap-yahoo", PASSWORD);
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "Could not establish a secure connection to the mail server"));
    f.mail.throttle_imap_login(true);
    let (s, b) = f.connect(f.a, "imap-yahoo", PASSWORD);
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "The mail server rejected the supplied username/password"));
    assert!(f.rows(f.a).is_empty() && strict.rows(strict.a).is_empty());
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_test_connection_answers_each_result_and_saves_nothing() {
    let f = Fixture::trusting();
    let test = |password: &str| {
        f.route(f.a, "POST", "/imap/test-connection", json!({"providerId":"imap-icloud","username":USER,"password":password}))
    };
    assert_eq!(test(PASSWORD), (200, json!({"result":"ok"})));
    assert_eq!(test("wrong"), (200, json!({"result":"auth_failed"})));
    let strict = Fixture::new(vec![]);
    let (s, b) = strict.route(strict.a, "POST", "/imap/test-connection", json!({"providerId":"imap-icloud","username":USER,"password":PASSWORD}));
    assert_eq!((s, b), (200, json!({"result":"tls_failed"})));
    assert!(f.rows(f.a).is_empty());
}

#[test]
#[ignore = "Only through verify-gate"]
fn bad_requests_are_refused_before_any_mail_server_is_tried() {
    let f = Fixture::trusting();
    let go = |body: Value| f.route(f.a, "POST", "/imap/connect", body);
    let (s, b) = go(json!({"providerId":"imap-other","username":"u","password":"p"}));
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "body/providerId must be equal to one of the allowed values"));
    let (s, b) = go(json!({"providerId":"imap-yahoo","username":"  ","password":"p"}));
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "username must not be empty"));
    let (s, b) = go(json!({"providerId":"imap-yahoo","username":"u"}));
    assert_eq!((s, b["error"].as_str().unwrap()), (400, "body must have required property 'password'"));
    assert_eq!(f.mail.imap_logins_seen(), 0);
}

fn reach(f: &Fixture, victim: &str) -> Result<(), String> {
    let (_, list) = f.route(f.b, "GET", "/accounts", Value::Null);
    if list["accounts"].as_array().unwrap().iter().any(|a| a["id"] == victim) {
        return Err("another person saw the mail account".into());
    }
    // The second person connects the same provider and must not touch the first person's row.
    let (s, body) = f.connect(f.b, "imap-fastmail", PASSWORD);
    if s != 201 || body["account"]["id"] == victim {
        return Err(format!("another person's connect reused the first person's account ({s})"));
    }
    if f.secret(victim)["username"] != USER || f.rows(f.a).len() != 1 {
        return Err("the first person's account changed".into());
    }
    Ok(())
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_second_person_cannot_see_or_overwrite_another_persons_mail_account() {
    let f = Fixture::trusting();
    let victim = f.connect(f.a, "imap-fastmail", PASSWORD).1["account"]["id"].as_str().unwrap().to_string();
    reach(&f, &victim).unwrap();
    assert_eq!(f.rows(f.b).len(), 1, "the second person has an account of their own");
    f.rt.block_on(f.root.execute("DELETE FROM app.connector_accounts WHERE owner_user_id=$1", &[&f.b])).unwrap();
    // Remove the protection, expect the same checks to fail, then restore it.
    let table = "app.connector_accounts";
    f.rt.block_on(f.root.batch_execute(&format!("ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))).unwrap();
    let red = reach(&f, &victim);
    f.rt
        .block_on(f.root.batch_execute(&format!("ALTER TABLE {table} ENABLE ROW LEVEL SECURITY; ALTER TABLE {table} FORCE ROW LEVEL SECURITY")))
        .unwrap();
    println!("RED without row security: {red:?}");
    assert!(red.is_err(), "proof did not notice removed row-level security");
}

fn leaks(texts: &[String]) -> Option<String> {
    texts.iter().find(|t| t.contains(PASSWORD)).cloned()
}

#[test]
#[ignore = "Only through verify-gate"]
fn the_mail_password_never_appears_in_an_answer_or_a_plain_row() {
    let f = Fixture::trusting();
    let (_, connected) = f.connect(f.a, "imap-fastmail", PASSWORD);
    let id = connected["account"]["id"].as_str().unwrap().to_string();
    let mut seen = vec![connected.to_string()];
    seen.push(f.connect(f.a, "imap-fastmail", "wrong-but-near-PASSWORD").1.to_string());
    for (method, path) in [("GET", "/accounts"), ("GET", "/providers"), ("GET", "/admin/accounts")] {
        seen.push(f.route(f.a, method, path, Value::Null).1.to_string());
    }
    let test = f.route(f.a, "POST", "/imap/test-connection", json!({"providerId":"imap-fastmail","username":USER,"password":PASSWORD}));
    seen.push(test.1.to_string());
    seen.extend(f.rows(f.a).iter().map(Value::to_string));
    assert_eq!(leaks(&seen), None);
    assert_eq!(f.secret(&id)["password"], PASSWORD, "the sealed copy still opens");
    // Without the sealing, the plain row carries the password and the same check goes red.
    let plain = json!({"kind":"imap-password","password":PASSWORD}).to_string();
    f.rt
        .block_on(f.root.execute(
            "UPDATE app.connector_accounts SET encrypted_secret = $2::text::jsonb WHERE id=$1",
            &[&id.parse::<Uuid>().unwrap(), &plain],
        ))
        .unwrap();
    let unsealed: Vec<String> = f.rows(f.a).iter().map(Value::to_string).collect();
    assert!(leaks(&unsealed).is_some(), "the check did not notice a plain password");
}

#[test]
fn the_test_only_mail_servers_must_be_on_this_machine() {
    let remote = Servers {
        imap_host: "imap.mail.yahoo.com".into(),
        imap_port: 993,
        imap_tls: true,
        smtp_host: "127.0.0.1".into(),
        smtp_port: 465,
        smtp_security: Smtp::ImplicitTls,
    };
    assert!(MailConfig::test_only_loopback(remote, vec![]).is_err());
}
