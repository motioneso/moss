//! Page reading through the real component, the real host fetch and a local HTTPS site. The only
//! fakes are a test name resolver and that site, which logs every request it receives.
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    context::ContextPorts,
    local::LocalPorts,
    public_web::{PublicWeb, Resolve, Resolved},
    runtime::{CallScope, Host, Limits, Request},
    services::ServicePorts,
};
use safety_core::secret::SecretCipher;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

struct NoAi;
impl Intelligence for NoAi {
    fn generate(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured AI")
    }
    fn embed(&self, _: &CallScope, _: &Request) -> Result<Value> {
        anyhow::bail!("No configured embeddings")
    }
}

const PUBLIC: &str = "93.184.216.34";
fn table() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        ("ok.test", vec![PUBLIC]),
        ("localhost", vec![PUBLIC]),
        ("deny.test", vec![PUBLIC]),
        ("rebind.test", vec!["10.0.0.9"]),
        ("loop.test", vec!["127.0.0.1"]),
        ("tail.test", vec!["100.64.1.1"]),
        ("mixed.test", vec![PUBLIC, "192.168.1.5"]),
    ]
}
struct Fixture {
    names: HashMap<String, Vec<IpAddr>>,
    dial: SocketAddr,
}
impl Resolve for Fixture {
    fn resolve(&self, host: &str, _: Duration) -> Result<Resolved> {
        let checked = self
            .names
            .get(host)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no such name"))?;
        Ok(Resolved {
            checked,
            dial: vec![self.dial],
        })
    }
}

struct Site {
    child: Child,
    dir: tempfile::TempDir,
    port: u16,
    pem: String,
}
impl Drop for Site {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Site {
    fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = (dir.path().join("cert.pem"), dir.path().join("key.pem"));
        let names: Vec<_> = table().iter().map(|(n, _)| format!("DNS:{n}")).collect();
        let made = Command::new("openssl")
            .args([
                "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                "-nodes", "-days", "2", "-subj", "/CN=ok.test", "-addext",
                "basicConstraints=critical,CA:FALSE", "-addext",
            ])
            .arg(format!("subjectAltName={}", names.join(",")))
            .arg("-keyout")
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()
            .unwrap();
        assert!(made.status.success(), "openssl failed");
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let ready = dir.path().join("ready");
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../rust-spike/module-host/tests/data/public_web_fixture.py");
        let child = Command::new("python3")
            .arg("-I")
            .arg(fixture)
            .args([
                cert.to_str().unwrap(),
                key.to_str().unwrap(),
                &port.to_string(),
                dir.path().join("log").to_str().unwrap(),
                ready.to_str().unwrap(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if ready.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(ready.exists(), "fixture site did not start");
        let pem = std::fs::read_to_string(&cert).unwrap();
        Self { child, dir, port, pem }
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("log")).unwrap_or_default()
    }
}

struct World {
    site: Site,
    services: Arc<ContextPorts>,
    _data: tempfile::TempDir,
}
impl World {
    fn new(pace: Duration) -> Self {
        let site = Site::start();
        let data = tempfile::tempdir().unwrap();
        let names = table()
            .into_iter()
            .map(|(n, ips)| (n.to_string(), ips.iter().map(|i| i.parse().unwrap()).collect()))
            .collect();
        let resolver = Arc::new(Fixture {
            names,
            dial: SocketAddr::new("127.0.0.1".parse().unwrap(), site.port),
        });
        let web = PublicWeb::new(resolver, Some(site.pem.clone()), pace);
        let services = ServicePorts::new(
            data.path(),
            Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
            Arc::new(NoAi),
            Arc::new(LocalPorts::new(data.path()).unwrap()),
        )
        .unwrap()
        .with_public_web(web);
        Self {
            site,
            services: Arc::new(ContextPorts::new(Arc::new(services))),
            _data: data,
        }
    }
    fn read_as(&self, who: uuid::Uuid, urls: Value) -> Value {
        let out = Host::new(Limits::default()).unwrap().call(
            &std::fs::read(
                std::env::var("WEB_RESEARCH_COMPONENT_WASM")
                    .expect("Run modules/web-research/tools/check.sh to build the component"),
            )
            .unwrap(),
            Arc::new(moss_web_research_host::package::manifest().unwrap()),
            AccessContext::new(who, "web-research-read"),
            self.services.clone(),
            "tool",
            &json!({"tool":"web.read","parameters":{"urls":urls}}).to_string(),
        )
        .unwrap();
        serde_json::from_str::<Value>(&out).unwrap()["data"].clone()
    }
    fn read(&self, urls: Value) -> Value {
        self.read_as(uuid::Uuid::new_v4(), urls)
    }
    fn reason(&self, url: &str) -> String {
        let data = self.read(json!([url]));
        assert_eq!(data["trace"]["fetchedUrlCount"], 0, "{data}");
        data["trace"]["documents"][0]["reason"].as_str().unwrap().to_owned()
    }
}

#[test]
fn a_public_page_becomes_readable_text_through_the_real_host() {
    let w = World::new(Duration::ZERO);
    let data = w.read(json!(["https://ok.test/article", "https://ok.test/plain"]));
    let docs = data["documents"].as_array().unwrap();
    assert_eq!(docs[0]["title"], "Fixture & Article");
    assert_eq!(docs[0]["text"], "Fixture & Article First line Second line");
    assert_eq!(docs[0]["domain"], "ok.test");
    assert_eq!(docs[1]["text"], "just plain words");
    assert!(docs[0]["fetchedAt"].as_str().unwrap().ends_with('Z'));
    let log = w.site.log();
    assert!(log.lines().next().unwrap().starts_with("ok.test /robots.txt"), "{log}");
    assert!(log.contains("UA=Moss-WebResearch/0.1"), "{log}");
}

#[test]
fn private_and_loopback_addresses_are_refused_before_any_request() {
    let w = World::new(Duration::ZERO);
    for url in [
        "https://10.0.0.5/",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://100.64.0.9/",
        "https://localhost/",
        "https://rebind.test/",
        "https://loop.test/",
        "https://tail.test/",
        "https://mixed.test/",
    ] {
        assert_eq!(w.reason(url), "blocked", "{url}");
    }
    let log = w.site.log();
    for name in ["rebind.test", "loop.test", "tail.test", "mixed.test"] {
        assert!(!log.contains(name), "{name} was contacted: {log}");
    }
}

#[test]
fn plain_http_and_odd_ports_are_refused() {
    let w = World::new(Duration::ZERO);
    assert_eq!(w.reason("http://ok.test/article"), "not_https");
    assert_eq!(w.reason("https://ok.test:8443/article"), "blocked");
    assert_eq!(w.reason("https://user:pw@ok.test/article"), "blocked");
    assert!(w.site.log().is_empty(), "{}", w.site.log());
}

#[test]
fn a_site_that_forbids_robots_is_not_read() {
    let w = World::new(Duration::ZERO);
    assert_eq!(w.reason("https://deny.test/article"), "robots");
    assert!(!w.site.log().contains("deny.test /article"), "{}", w.site.log());
}

#[test]
fn one_site_is_paced_and_a_long_wait_is_refused() {
    let w = World::new(Duration::from_millis(400));
    let started = std::time::Instant::now();
    // The robots file and the page are two calls to one site.
    let data = w.read(json!(["https://ok.test/article"]));
    assert_eq!(data["documents"].as_array().unwrap().len(), 1, "{data}");
    assert!(started.elapsed() >= Duration::from_millis(400), "{:?}", started.elapsed());
    let slow = World::new(Duration::from_secs(30));
    assert_eq!(slow.reason("https://ok.test/article"), "rate_limited");
    assert!(!slow.site.log().contains("ok.test /article"), "{}", slow.site.log());
}

#[test]
fn two_people_each_get_their_own_read_and_nothing_private_is_kept() {
    let w = World::new(Duration::ZERO);
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let one = w.read_as(a, json!(["https://ok.test/article"]));
    let two = w.read_as(b, json!(["https://ok.test/plain"]));
    assert_eq!(one["documents"][0]["title"], "Fixture & Article");
    assert_eq!(two["documents"][0]["text"], "just plain words");
    assert!(!two.to_string().contains("Fixture"));
}
