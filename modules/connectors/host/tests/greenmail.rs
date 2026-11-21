//! Send and reply proof against a real GreenMail container (plain IMAP 3143, SMTP 3025). The
//! real Rust package runs in WebAssembly with the real host and database. Email is a recorded
//! stand-in, so the reply context is scripted. The mail server is real: what Moss sends is read
//! back from GreenMail's own mailboxes with an independent client. Run only through the gate.
use access_context::AccessContext;
use moss_connectors_host::{
    imap::MailConfig,
    mail_probe::{Servers, Smtp},
    package, ConnectorsPorts,
};
use moss_module_host::runtime::{CallScope, Host, Limits, Ports, Request};
use safety_core::db::{Database, RuntimeRole};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_postgres::NoTls;
use uuid::Uuid;

const KEY: &str = "connector-test-key-0123456789abcdef";
const USER: &str = "probe@greenmail.test";
const PASSWORD: &str = "probe-pw";

struct Seen {
    original: Mutex<Value>,
}

impl Ports for Seen {
    fn invoke(&self, _: &CallScope, port: &str, request: &Request) -> anyhow::Result<Value> {
        let name = request.parameters["name"].as_str().unwrap_or(&request.operation).to_string();
        Ok(match (port, name.as_str()) {
            ("context", "read") => json!({"now":"2026-03-02T08:00:00.000Z"}),
            ("api", "replyContext") => self.original.lock().unwrap().clone(),
            _ => anyhow::bail!("unexpected {port} {name}"),
        })
    }
}

/// Every message in one folder of one GreenMail mailbox, fetched by a plain IMAP client.
fn mailbox(user: &str, password: &str, folder: &str) -> Vec<String> {
    let s = TcpStream::connect(("127.0.0.1", 3143)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut w = s.try_clone().unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let mut run = |tag: &str, cmd: &str| -> String {
        w.write_all(format!("{tag} {cmd}\r\n").as_bytes()).unwrap();
        let mut all = String::new();
        loop {
            line.clear();
            if r.read_line(&mut line).unwrap() == 0 {
                break;
            }
            all.push_str(&line);
            if line.starts_with(tag) {
                break;
            }
        }
        all
    };
    // A mailbox nobody delivered to does not exist, so its login fails.
    if !run("a1", &format!("LOGIN {user} {password}")).contains("a1 OK") {
        return vec![];
    }
    let selected = run("a2", &format!("SELECT \"{folder}\""));
    if !selected.contains("a2 OK") {
        return vec![];
    }
    let count: usize = selected.lines().find_map(|l| l.strip_suffix(" EXISTS").and_then(|l| l.trim_start_matches("* ").parse().ok())).unwrap_or(0);
    (1..=count).map(|n| run(&format!("f{n}"), &format!("FETCH {n} BODY[]"))).collect()
}

struct Fixture {
    ports: Arc<ConnectorsPorts>,
    seen: Arc<Seen>,
    a: Uuid,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let a = Uuid::new_v4();
        let db = rt.block_on(async {
            let (root, c) = tokio_postgres::connect(&std::env::var("JS48_BOOTSTRAP_URL").unwrap(), NoTls).await.unwrap();
            tokio::spawn(async move {
                let _ = c.await;
            });
            root.execute("INSERT INTO app.users(id,email,name,is_instance_admin) VALUES($1,$2,'Greenmail A',true)", &[&a, &format!("{a}@example.test")])
                .await
                .unwrap();
            Database::connect(&std::env::var("JS48_APP_URL").unwrap(), 8, RuntimeRole::App).await.unwrap()
        });
        std::mem::forget(rt);
        let seen = Arc::new(Seen { original: Mutex::new(Value::Null) });
        let servers = Servers {
            imap_host: "127.0.0.1".into(),
            imap_port: 3143,
            imap_tls: false,
            smtp_host: "127.0.0.1".into(),
            smtp_port: 3025,
            smtp_security: Smtp::None,
        };
        let ports = Arc::new(ConnectorsPorts::new(db, seen.clone(), KEY).unwrap().with_mail(MailConfig::test_only_loopback(servers, vec![]).unwrap()));
        Self { ports, seen, a }
    }

    fn call(&self, entry: &str, payload: Value) -> Value {
        let wasm = package::component(&std::fs::read(std::env::var("CONNECTORS_CORE_WASM").expect("CONNECTORS_CORE_WASM")).unwrap()).unwrap();
        let out = Host::new(Limits::default())
            .unwrap()
            .call(&wasm, Arc::new(package::manifest().unwrap()), AccessContext::new(self.a, "greenmail-proof"), self.ports.clone(), entry, &payload.to_string())
            .unwrap();
        serde_json::from_str(&out).unwrap()
    }

    fn connect(&self) -> Uuid {
        let reply = self.call("route", json!({"method":"POST","path":"/imap/connect","params":{},"query":{},"body":{"providerId":"imap-fastmail","username":USER,"password":PASSWORD}}));
        assert_eq!(reply["status"], 201, "{reply}");
        reply["body"]["account"]["id"].as_str().unwrap().parse().unwrap()
    }

    fn reply(&self, account: Uuid, to: &str, subject: &str, body: &str, tool: &str) -> Value {
        *self.seen.original.lock().unwrap() = json!({
            "accountId":account.to_string(),"sender":format!("Ann Lee <{to}>"),"subject":subject,
            "threadId":null,"messageId":"orig-1@greenmail.test","references":["orig-0@greenmail.test"]});
        let parameters = json!({"cacheMessageId":"c1","body":body});
        let card = self.call("api", json!({"name":"prepareEmailAction","parameters":parameters}));
        let out = self.call("tool", json!({"tool":tool,"parameters":parameters,"approvalVersion":card["version"].clone()}));
        let mut data = out["data"].clone();
        if tool == "email.draftReply" && data["ok"] == true {
            let changed = data.as_object_mut().unwrap().remove("changed")
                .expect("A saved reply draft must report its receipt");
            assert_eq!(changed, json!([
                {"label":"Reply draft","before":"No new draft","after":body}
            ]));
        }
        data
    }
}

#[test]
#[ignore = "Only through verify-gate, with the greenmail container running"]
fn a_reply_is_delivered_by_greenmail_and_a_draft_is_kept_unsent() {
    let f = Fixture::new();
    let run = Uuid::new_v4().simple().to_string();
    let recipient = format!("ann-{run}@greenmail.test");
    let id = f.connect();
    let sent_body = format!("GREEN-REPLY-BODY-{run}");
    let out = f.reply(id, &recipient, &format!("Lunch {run}"), &sent_body, "email.sendReply");
    assert_eq!(out, json!({"ok":true,"mode":"sent"}), "{out}");
    // GreenMail makes the recipient's mailbox on delivery, with the address as the password.
    let inbox = mailbox(&recipient, &recipient, "INBOX");
    assert_eq!(inbox.len(), 1, "the recipient got exactly one message: {inbox:?}");
    let m = &inbox[0];
    assert!(m.contains(&sent_body) && m.contains(&format!("Subject: Re: Lunch {run}")) && m.contains("In-Reply-To: <orig-1@greenmail.test>") && m.contains(USER), "{m}");
    let filed: Vec<_> = mailbox(USER, PASSWORD, "Sent").into_iter().filter(|m| m.contains(&sent_body)).collect();
    assert_eq!(filed.len(), 1, "a copy sits in the sender's Sent folder");
    println!("PASS reply delivered once to the recipient's real mailbox, on the thread, and copied to Sent");
    let draft_body = format!("GREEN-DRAFT-BODY-{run}");
    let other = format!("bob-{run}@greenmail.test");
    let out = f.reply(id, &other, &format!("Plans {run}"), &draft_body, "email.draftReply");
    assert_eq!(out, json!({"ok":true,"mode":"drafted"}), "{out}");
    let drafts: Vec<_> = mailbox(USER, PASSWORD, "Drafts").into_iter().filter(|m| m.contains(&draft_body)).collect();
    assert_eq!(drafts.len(), 1, "the draft is filed in Drafts");
    // Nothing was delivered to the draft's recipient.
    assert!(mailbox(&other, &other, "INBOX").is_empty(), "a draft is never sent");
    println!("PASS draft filed in Drafts and not delivered to anyone");
}
