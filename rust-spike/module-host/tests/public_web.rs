//! Public-web fetch proof. A real guest component calls the real host. The only fakes are a test
//! name resolver and a local HTTPS site that records every request it receives.
mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    local::LocalPorts,
    manifest::{Capability, Manifest},
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
/// Name to the addresses the guard sees. Every name dials the local fixture site.
fn table() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        ("ok.test", vec![PUBLIC]),
        ("private.test", vec![PUBLIC]),
        ("deny.test", vec![PUBLIC]),
        ("broken.test", vec![PUBLIC]),
        ("www.reddit.com", vec![PUBLIC]),
        ("rebind.test", vec!["10.0.0.9"]),
        ("loop.test", vec!["127.0.0.1"]),
        ("tail.test", vec!["100.64.1.1"]),
        ("mixed.test", vec![PUBLIC, "192.168.1.5"]),
        ("ula.test", vec!["fd7a:115c:a1e0::1"]),
        ("sixtofour.test", vec!["2002:0a00:0001::1"]),
        ("v4mapped.test", vec!["::ffff:10.0.0.1"]),
    ]
}
struct Fixture {
    names: HashMap<String, Vec<IpAddr>>,
    dial: SocketAddr,
    dead: SocketAddr,
}
impl Resolve for Fixture {
    fn resolve(&self, host: &str, _: Duration) -> Result<Resolved> {
        if host == "dead.test" {
            return Ok(Resolved {
                checked: vec![PUBLIC.parse()?],
                dial: vec![self.dead],
            });
        }
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
        let mut names: Vec<_> = table().iter().map(|(n, _)| format!("DNS:{n}")).collect();
        names.push("DNS:dead.test".into());
        let made = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:prime256v1",
                "-nodes",
                "-days",
                "2",
                "-subj",
                "/CN=ok.test",
                "-addext",
                "basicConstraints=critical,CA:FALSE",
                "-addext",
            ])
            .arg(format!("subjectAltName={}", names.join(",")))
            .arg("-keyout")
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()
            .unwrap();
        assert!(made.status.success(), "openssl failed");
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let ready = dir.path().join("ready");
        let child = Command::new("python3")
            .arg("-I")
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/public_web_fixture.py"))
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
        Self {
            child,
            dir,
            port,
            pem,
        }
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("log")).unwrap_or_default()
    }
    fn hits(&self) -> usize {
        self.log().lines().count()
    }
    fn resolver(&self) -> Arc<Fixture> {
        let names = table()
            .into_iter()
            .map(|(n, ips)| {
                (
                    n.to_string(),
                    ips.iter().map(|i| i.parse().unwrap()).collect(),
                )
            })
            .collect();
        // A port nothing listens on, for the "network" failure.
        let dead_port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        Arc::new(Fixture {
            names,
            dial: SocketAddr::new("127.0.0.1".parse().unwrap(), self.port),
            dead: SocketAddr::new("127.0.0.1".parse().unwrap(), dead_port),
        })
    }
}

struct World {
    site: Site,
    host: Host,
    services: Arc<ServicePorts>,
    manifest: Manifest,
    _data: tempfile::TempDir,
}
impl World {
    fn new(pace: Duration) -> Self {
        Self::with(pace, true)
    }
    fn with(pace: Duration, declare: bool) -> Self {
        let site = Site::start();
        let data = tempfile::tempdir().unwrap();
        let web = PublicWeb::new(site.resolver(), Some(site.pem.clone()), pace);
        let services = Arc::new(
            ServicePorts::new(
                data.path(),
                Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                Arc::new(NoAi),
                Arc::new(LocalPorts::new(data.path()).unwrap()),
            )
            .unwrap()
            .with_public_web(web),
        );
        let mut manifest = common::manifest("1.0.0");
        if declare {
            manifest.capabilities.push(Capability {
                port: "fetch".into(),
                operations: ["get".into()].into(),
                resources: ["public-web".into()].into(),
                allow_private: false,
            });
        }
        Self {
            site,
            host: Host::new(Limits::default()).unwrap(),
            services,
            manifest,
            _data: data,
        }
    }
    fn raw(
        &self,
        who: uuid::Uuid,
        operation: &str,
        resource: &str,
        parameters: Value,
    ) -> Result<Value> {
        let wasm = wat::parse_str(
            include_str!("../sample/module.wat").replace("moss:module/kv@", "moss:module/fetch@"),
        )?;
        let out = self.host.call(
            &wasm,
            Arc::new(self.manifest.clone()),
            AccessContext::new(who, "public-web"),
            self.services.clone(),
            "route",
            &json!({"operation":operation,"resource":resource,"parameters":parameters}).to_string(),
        )?;
        Ok(serde_json::from_str(&out)?)
    }
    fn get(&self, parameters: Value) -> Value {
        self.raw(uuid::Uuid::new_v4(), "get", "public-web", parameters)
            .unwrap()
    }
    fn url(&self, host: &str, path: &str) -> String {
        format!("https://{host}{path}")
    }
    fn ok(&self, host: &str, path: &str) -> Value {
        self.get(json!({"url":self.url(host,path)}))
    }
}
fn reason(v: &Value) -> (String, Option<String>) {
    assert_eq!(v["ok"], false, "{v}");
    (
        v["reason"].as_str().unwrap().to_owned(),
        v["detail"].as_str().map(str::to_owned),
    )
}
fn is(v: &Value, reason_name: &str) {
    assert_eq!(reason(v).0, reason_name, "{v}");
}

#[test]
fn a_public_page_is_read_after_the_robots_file_and_with_a_plain_agent() {
    let w = World::new(Duration::ZERO);
    let v = w.ok("ok.test", "/page");
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["status"], 200);
    assert_eq!(v["hopCount"], 0);
    assert_eq!(v["truncated"], false);
    assert!(v["body"].as_str().unwrap().contains("hello from ok.test"));
    assert!(v["contentType"].as_str().unwrap().starts_with("text/html"));
    let log = w.site.log();
    let lines: Vec<_> = log.lines().collect();
    assert!(lines[0].starts_with("ok.test /robots.txt"), "{log}");
    assert!(lines[1].starts_with("ok.test /page"), "{log}");
    assert!(lines[1].ends_with("UA=Moss-PublicWeb"), "{log}");
    // The robots answer is cached, so a second read asks only for the page.
    w.ok("ok.test", "/page2");
    assert_eq!(w.site.hits(), 3, "{}", w.site.log());
}

#[test]
fn redirects_are_followed_and_counted() {
    let w = World::new(Duration::ZERO);
    let v = w.ok("ok.test", "/redirect?to=https://ok.test/final");
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["hopCount"], 1);
    assert_eq!(v["finalUrl"], "https://ok.test/final");
    let v = w.ok(
        "ok.test",
        "/redirect?to=/redirect%3Fto=/redirect%3Fto=/redirect%3Fto=/x",
    );
    is(&v, "network");
}

#[test]
fn private_loopback_tailnet_and_reserved_destinations_never_reach_the_network() {
    let w = World::new(Duration::ZERO);
    let literals = [
        "https://10.0.0.5/",
        "https://127.0.0.1/",
        "https://100.100.1.1/",
        "https://169.254.169.254/latest",
        "https://192.168.1.1/",
        "https://[::1]/",
        "https://[fd7a:115c:a1e0::1]/",
        "https://[fe80::1]/",
        "https://[::ffff:10.0.0.1]/",
        "https://[2002:0a00:0001::1]/",
        "https://localhost/",
        "https://app.localhost/",
        "https://2130706433/",
        "https://0x7f.1/",
    ];
    for url in literals {
        is(&w.get(json!({"url":url})), "blocked");
    }
    for name in [
        "rebind.test",
        "loop.test",
        "tail.test",
        "mixed.test",
        "ula.test",
        "sixtofour.test",
        "v4mapped.test",
        "unknown.test",
    ] {
        is(&w.ok(name, "/"), "blocked");
    }
    assert_eq!(
        w.site.hits(),
        0,
        "A refused address was contacted: {}",
        w.site.log()
    );
}

#[test]
fn every_redirect_hop_is_checked_again() {
    let w = World::new(Duration::ZERO);
    for to in [
        "https://10.0.0.5/",
        "https://rebind.test/",
        "https://loop.test/",
        "https://127.0.0.1/",
        "https://mixed.test/",
        "https://[fd7a:115c:a1e0::1]/",
    ] {
        let v = w.ok("ok.test", &format!("/redirect?to={to}"));
        is(&v, "blocked");
    }
    is(
        &w.ok("ok.test", "/redirect?to=http://ok.test/plain"),
        "not_https",
    );
    is(
        &w.ok("ok.test", "/redirect?to=https://ok.test:8443/x"),
        "blocked",
    );
    is(&w.ok("ok.test", "/redirect?to=ftp://ok.test/x"), "blocked");
    let log = w.site.log();
    assert!(
        !log.lines()
            .any(|l| ["rebind.test ", "loop.test ", "mixed.test "]
                .iter()
                .any(|h| l.starts_with(h))),
        "{log}"
    );
}

#[test]
fn only_https_on_the_standard_port_without_a_password_is_allowed() {
    let w = World::new(Duration::ZERO);
    is(&w.get(json!({"url":"http://ok.test/"})), "not_https");
    is(&w.get(json!({"url":"https://ok.test:8443/"})), "blocked");
    is(&w.get(json!({"url":"https://user:pw@ok.test/"})), "blocked");
    is(&w.get(json!({"url":"ftp://ok.test/"})), "blocked");
    is(&w.get(json!({"url":"not a url"})), "blocked");
    assert_eq!(w.site.hits(), 0);
}

#[test]
fn robots_rules_are_honoured_and_an_unreadable_file_blocks() {
    let w = World::new(Duration::ZERO);
    is(&w.ok("deny.test", "/anything"), "robots");
    is(&w.ok("private.test", "/private/x"), "robots");
    assert_eq!(w.ok("private.test", "/private/open/x")["ok"], true);
    assert_eq!(w.ok("private.test", "/public")["ok"], true);
    is(&w.ok("broken.test", "/"), "robots");
    let log = w.site.log();
    assert!(
        !log.contains("deny.test /anything") && !log.contains("private.test /private/x"),
        "{log}"
    );
}

#[test]
fn only_the_reddit_feed_address_may_skip_robots() {
    let w = World::new(Duration::ZERO);
    is(&w.ok("www.reddit.com", "/r/rust/hot.rss"), "robots");
    let v = w.get(json!({"url":w.url("www.reddit.com","/r/rust/hot.rss"),"skipRobots":true}));
    assert_eq!(v["ok"], true, "{v}");
    let v = w.get(json!({"url":w.url("deny.test","/x"),"skipRobots":true}));
    is(&v, "robots");
}

#[test]
fn server_failures_become_reasons_and_never_carry_a_body() {
    let w = World::new(Duration::ZERO);
    let v = w.ok("ok.test", "/status/500");
    assert_eq!(
        (v["reason"].as_str(), v["status"].as_u64()),
        (Some("http_error"), Some(500)),
        "{v}"
    );
    let v = w.ok("ok.test", "/status/404");
    assert_eq!(v["status"], 404);
    let v = w.ok("ok.test", "/status/429?after=120");
    assert_eq!(
        (
            v["reason"].as_str(),
            v["status"].as_u64(),
            v["retryAfter"].as_str()
        ),
        (Some("rate_limited"), Some(429), Some("120")),
        "{v}"
    );
    let v = w.ok(
        "ok.test",
        "/status/503?after=Wed,%2021%20Oct%202026%2007:28:00%20GMT",
    );
    assert_eq!(v["reason"], "http_error");
    assert!(v["retryAfter"].as_str().unwrap().starts_with("Wed, 21 Oct"));
    let v = w.ok("ok.test", "/challenge");
    assert_eq!(
        (v["reason"].as_str(), v["status"].as_u64()),
        (Some("challenge"), Some(403)),
        "{v}"
    );
    for v in [
        w.ok("ok.test", "/status/500"),
        w.ok("ok.test", "/challenge"),
    ] {
        assert!(
            !v.to_string().contains("secret-"),
            "A failure carried the response body: {v}"
        );
    }
}

#[test]
fn time_size_and_content_type_caps_apply() {
    let w = World::new(Duration::ZERO);
    let v = w.get(json!({"url":w.url("ok.test","/slow?s=5"),"timeoutMs":700}));
    is(&v, "timeout");
    is(&w.get(json!({"url":w.url("dead.test","/")})), "network");
    let v = w.get(json!({"url":w.url("ok.test","/big?n=1000"),"maxBytes":100}));
    assert_eq!(
        (
            v["ok"].as_bool(),
            v["truncated"].as_bool(),
            v["body"].as_str().unwrap().len()
        ),
        (Some(true), Some(true), 100)
    );
    let v = w.get(json!({"url":w.url("ok.test","/big?n=1000"),"maxBytes":100,"rejectOversizedResponses":true}));
    assert_eq!(
        reason(&v),
        ("blocked".into(), Some("response_too_large".into()))
    );
    let v = w.get(
        json!({"url":w.url("ok.test","/big?n=100"),"maxBytes":100,"rejectOversizedResponses":true}),
    );
    assert_eq!(v["ok"], true, "{v}");
    let v = w.get(json!({"url":w.url("ok.test","/lying-length"),"rejectOversizedResponses":true}));
    assert!(
        matches!(reason(&v).1.as_deref(), Some("invalid_response")) || reason(&v).0 == "network",
        "{v}"
    );
    let v = w.get(json!({"url":w.url("ok.test","/bad-length")}));
    assert!(
        matches!(reason(&v).1.as_deref(), Some("invalid_response")) || reason(&v).0 == "network",
        "{v}"
    );
    let v = w.get(json!({"url":w.url("ok.test","/feed.xml"),"allowedContentTypes":["application/rss+xml","text/xml"]}));
    assert_eq!(v["ok"], true, "{v}");
    let v = w.get(json!({"url":w.url("ok.test","/feed.xml"),"allowedContentTypes":["text/html"]}));
    assert_eq!(
        reason(&v),
        ("blocked".into(), Some("unsupported_content_type".into()))
    );
    let v = w.get(json!({"url":w.url("ok.test","/binary"),"encoding":"base64"}));
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(v["body"].as_str().unwrap())
            .unwrap(),
        (0..=255u8).collect::<Vec<_>>()
    );
    // A package may narrow the hosts a read can reach, never widen them.
    let v = w.get(json!({"url":w.url("ok.test","/redirect?to=https://private.test/"),"allowedHosts":["ok.test"]}));
    is(&v, "blocked");
}

#[test]
fn one_host_is_paced_and_a_long_wait_is_refused() {
    let w = World::new(Duration::from_millis(400));
    let started = std::time::Instant::now();
    // The robots file and the page are two calls to one host.
    assert_eq!(w.ok("ok.test", "/page")["ok"], true);
    assert!(
        started.elapsed() >= Duration::from_millis(400),
        "{:?}",
        started.elapsed()
    );
    let slow = World::new(Duration::from_secs(30));
    is(&slow.ok("ok.test", "/page"), "rate_limited");
}

#[test]
fn a_package_cannot_use_the_mode_without_declaring_it_or_for_other_hosts() {
    let w = World::with(Duration::ZERO, false);
    let a = uuid::Uuid::new_v4();
    let params = json!({"url":"https://ok.test/"});
    assert!(w.raw(a, "get", "public-web", params.clone()).is_err());
    let w = World::new(Duration::ZERO);
    assert!(
        w.raw(a, "get", "ok.test", params.clone()).is_err(),
        "an undeclared exact host"
    );
    assert!(
        w.raw(a, "post", "public-web", params.clone()).is_err(),
        "an undeclared operation"
    );
    assert!(w.raw(a, "get", "public-web", json!({})).is_err(), "no url");
    for extra in [
        json!({"url":"https://ok.test/","headers":{"authorization":"x"}}),
        json!({"url":"https://ok.test/","body":{}}),
        json!({"url":"https://ok.test/","actor":"x"}),
    ] {
        let r = w.raw(a, "get", "public-web", extra);
        assert!(r.is_err() || r.unwrap()["ok"] == false);
    }
    assert_eq!(w.site.hits(), 0);
}

#[test]
fn activity_names_the_mode_only_and_belongs_to_one_person() {
    let w = World::new(Duration::ZERO);
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let marker = "/zebra-marker-7731?q=secret-topic-4410";
    let v = w
        .raw(
            a,
            "get",
            "public-web",
            json!({"url":w.url("ok.test",marker)}),
        )
        .unwrap();
    assert_eq!(v["ok"], true);
    let mine = w
        .services
        .activity(&w.manifest.id, &AccessContext::new(a, "read"))
        .unwrap();
    let theirs = w
        .services
        .activity(&w.manifest.id, &AccessContext::new(b, "read"))
        .unwrap();
    assert_eq!(mine.len(), 1, "{mine:?}");
    let text = json!(mine).to_string();
    assert!(text.contains("public-web"), "{text}");
    for planted in ["zebra-marker-7731", "secret-topic-4410", "ok.test"] {
        assert!(
            !text.contains(planted),
            "The activity row recorded {planted}: {text}"
        );
    }
    assert!(
        theirs.is_empty(),
        "A second person saw activity: {theirs:?}"
    );
}
