//! Browser port proof. A real guest component calls the real host, which starts the pinned
//! Chromium in a network namespace. The only fakes are a test name resolver, a local HTTPS site
//! and a listener that counts every connection and datagram that reaches it.
//!
//! Run with `tools/browser-gate.sh`. Needs MOSS_BROWSER_DIR (see tools/fetch-chrome.sh) and
//! `--features browser-proof`.
#![cfg(feature = "browser-proof")]
mod common;
use access_context::AccessContext;
use anyhow::Result;
use moss_module_host::{
    ai::Intelligence,
    browser::{
        launch::{Isolation, Launcher},
        Weakened,
    },
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
    net::{IpAddr, SocketAddr, TcpListener, UdpSocket},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

/// How long the host lets one call run. Tests run one at a time.
static CALL_SECONDS: AtomicU64 = AtomicU64::new(30);

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
const NAMES: &[(&str, &str)] = &[
    ("ok.test", PUBLIC),
    ("other.test", PUBLIC),
    ("private.test", "10.0.0.9"),
];

struct Names {
    table: HashMap<String, Vec<IpAddr>>,
    dial: SocketAddr,
}
impl Resolve for Names {
    fn resolve(&self, host: &str, _: Duration) -> Result<Resolved> {
        let checked = self
            .table
            .get(host)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no such name"))?;
        Ok(Resolved {
            checked,
            dial: vec![self.dial],
        })
    }
}

/// Counts what reaches the host's loopback outside any namespace.
struct Listener {
    port: u16,
    tcp: Arc<AtomicUsize>,
    udp: Arc<AtomicUsize>,
}
impl Listener {
    fn start() -> Self {
        let (tcp_socket, udp_socket) = loop {
            let tcp = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = tcp.local_addr().unwrap().port();
            if let Ok(udp) = UdpSocket::bind(("127.0.0.1", port)) {
                break (tcp, udp);
            }
        };
        let port = tcp_socket.local_addr().unwrap().port();
        let (tcp, udp) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let counter = tcp.clone();
        std::thread::spawn(move || {
            for stream in tcp_socket.incoming().flatten() {
                counter.fetch_add(1, Ordering::SeqCst);
                drop(stream);
            }
        });
        let counter = udp.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 2048];
            while udp_socket.recv_from(&mut buffer).is_ok() {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });
        Self { port, tcp, udp }
    }
    fn hits(&self) -> (usize, usize) {
        (self.tcp.load(Ordering::SeqCst), self.udp.load(Ordering::SeqCst))
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
    fn start(listener_port: u16) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = (dir.path().join("cert.pem"), dir.path().join("key.pem"));
        let names: Vec<_> = NAMES.iter().map(|(n, _)| format!("DNS:{n}")).collect();
        let made = Command::new("openssl")
            .args([
                "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                "-days", "2", "-subj", "/CN=ok.test", "-addext", "basicConstraints=critical,CA:FALSE",
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
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let ready = dir.path().join("ready");
        let child = Command::new("python3")
            .arg("-I")
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/browser_fixture.py"))
            .args([
                cert.to_str().unwrap(),
                key.to_str().unwrap(),
                &port.to_string(),
                dir.path().join("log").to_str().unwrap(),
                ready.to_str().unwrap(),
                &listener_port.to_string(),
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
    fn resolver(&self) -> Arc<Names> {
        Arc::new(Names {
            table: NAMES
                .iter()
                .map(|(n, ip)| (n.to_string(), vec![ip.parse().unwrap()]))
                .collect(),
            dial: SocketAddr::new("127.0.0.1".parse().unwrap(), self.port),
        })
    }
}

fn chrome_dir() -> PathBuf {
    PathBuf::from(std::env::var("MOSS_BROWSER_DIR").expect("MOSS_BROWSER_DIR is not set"))
}

struct World {
    site: Site,
    listener: Listener,
    host: Host,
    services: Arc<ServicePorts>,
    manifest: Manifest,
    _data: tempfile::TempDir,
}
impl World {
    fn new() -> Self {
        Self::with(Launcher::new(chrome_dir()))
    }
    fn with(launcher: Launcher) -> Self {
        Self::build(launcher, Weakened::default(), false, false)
    }
    fn build(launcher: Launcher, weakened: Weakened, private_ok: bool, pooled: bool) -> Self {
        let listener = Listener::start();
        let site = Site::start(listener.port);
        let data = tempfile::tempdir().unwrap();
        let mut web = PublicWeb::new(site.resolver(), Some(site.pem.clone()), Duration::ZERO);
        if private_ok {
            web = web.with_private_destinations_allowed();
        }
        let mut services =
            ServicePorts::new(
                data.path(),
                Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                Arc::new(NoAi),
                Arc::new(LocalPorts::new(data.path()).unwrap()),
            )
            .unwrap()
            .with_public_web(web)
            .with_weakened_browser(launcher, weakened);
        if pooled {
            services = services.with_pooled_people();
        }
        let services = Arc::new(services);
        let mut manifest = common::manifest("1.0.0");
        manifest.capabilities.push(Capability {
            port: "browser".into(),
            operations: ["render".into()].into(),
            resources: ["public-web".into()].into(),
            allow_private: false,
        });
        Self {
            site,
            listener,
            host: Host::new(Limits {
                deadline: Duration::from_secs(CALL_SECONDS.load(Ordering::SeqCst)),
                ..Limits::default()
            })
            .unwrap(),
            services,
            manifest,
            _data: data,
        }
    }
    /// One call from a guest. `kind` is the handler kind, `who` the signed-in person.
    fn call(&self, who: uuid::Uuid, kind: &str, parameters: Value) -> Result<Value> {
        // The sample guest calls its port only for a route. Byte 106 makes it do so for a job.
        let mut text = include_str!("../sample/module.wat")
            .replace("moss:module/kv@", "moss:module/browser@");
        if kind == "job" {
            text = text.replace("i32.const 114 i32.eq", "i32.const 106 i32.eq");
        }
        let out = self.host.call(
            &wat::parse_str(text)?,
            Arc::new(self.manifest.clone()),
            AccessContext::new(who, "browser"),
            self.services.clone(),
            kind,
            &json!({"operation":"render","resource":"public-web","parameters":parameters}).to_string(),
        )?;
        Ok(serde_json::from_str(&out)?)
    }
    fn render(&self, path: &str, hosts: &[&str]) -> Value {
        self.call(
            uuid::Uuid::new_v4(),
            "route",
            json!({"url":format!("https://ok.test{path}"),"allowedHosts":hosts}),
        )
        .unwrap()
    }
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn a_page_built_by_scripts_gives_bounded_evidence() {
    let w = World::new();
    let v = w.render("/news", &["ok.test"]);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["title"], "Fixture Sports");
    assert!(v["text"].as_str().unwrap().contains("Zebra-marker headline number 0"));
    let urls: Vec<_> = v["candidates"].as_array().unwrap().iter().map(|c| c["url"].as_str().unwrap()).collect();
    assert_eq!(urls.len(), 5, "{urls:?}");
    assert!(urls.iter().all(|u| u.starts_with("https://ok.test/story/")), "{urls:?}");
    let log = w.site.log();
    assert!(log.contains("ok.test /api/headlines"), "{log}");
    assert!(!log.contains("other.test"), "{log}");
}

/// Every way a page can try to reach the network without a plain request.
const PROBES: &[&str] = &["ws", "rtc", "sw", "prefetch", "preconnect", "dns", "fetch", "img"];

/// Renders one probe and waits for any late connection to arrive. Returns what the listener saw.
fn probe(w: &World, which: &str) -> (usize, usize) {
    let v = w.render(&format!("/probe?only={which}"), &["ok.test"]);
    assert_eq!(v["ok"], true, "{v}");
    std::thread::sleep(Duration::from_millis(700));
    println!("probe {which}: page said {} listener saw {:?}", v["text"], w.listener.hits());
    w.listener.hits()
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn websocket_webrtc_service_worker_dns_and_prefetch_reach_nothing() {
    for which in PROBES {
        let w = World::new();
        assert_eq!(probe(&w, which), (0, 0), "{which} reached the listener");
        let log = w.site.log();
        assert!(!log.contains("127.0.0.1"), "{log}");
    }
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn control_without_the_namespace_the_probes_reach_the_listener() {
    let mut reached = vec![];
    for which in PROBES {
        let w = World::with(Launcher::new(chrome_dir()).with_isolation(Isolation::None));
        let (tcp, udp) = probe(&w, which);
        if tcp + udp > 0 {
            reached.push(*which);
        }
    }
    println!("reached the listener without the namespace: {reached:?}");
    for needed in ["ws", "rtc"] {
        assert!(reached.contains(&needed), "{needed} was not seen reaching the listener");
    }
}


#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn a_scheduled_job_is_refused_and_no_browser_starts() {
    let w = World::new();
    let v = w
        .call(
            uuid::Uuid::new_v4(),
            "job",
            json!({"url":"https://ok.test/news","allowedHosts":["ok.test"]}),
        )
        .unwrap();
    assert_eq!(v, json!({"ok":false,"reason":"blocked"}));
    assert_eq!(w.site.log(), "", "a job caused a request");
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn off_list_and_private_requests_are_refused_and_each_guard_is_seen_failing_without_it() {
    let hosts = ["ok.test", "private.test"];
    let w = World::new();
    assert_eq!(w.render("/guards", &hosts)["ok"], true);
    let log = w.site.log();
    assert!(!log.contains("other.test"), "off-list host reached the site: {log}");
    assert!(!log.contains("private.test"), "private address reached the site: {log}");
    drop(w);

    // Without the host list the off-list script is fetched.
    let w = World::build(
        Launcher::new(chrome_dir()),
        Weakened { host_list: true },
        false,
        false,
    );
    assert_eq!(w.render("/guards", &hosts)["ok"], true);
    assert!(w.site.log().contains("other.test /off-list.js"), "{}", w.site.log());
    drop(w);

    // Without the private-address check the private name is fetched.
    let w = World::build(Launcher::new(chrome_dir()), Weakened::default(), true, false);
    assert_eq!(w.render("/guards", &hosts)["ok"], true);
    assert!(w.site.log().contains("private.test /private.js"), "{}", w.site.log());
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn a_document_off_the_list_or_off_https_is_refused_before_a_browser_starts() {
    let w = World::new();
    for url in ["https://other.test/news", "http://ok.test/news", "https://ok.test:8443/news", "ftp://ok.test/"] {
        let v = w
            .call(uuid::Uuid::new_v4(), "route", json!({"url":url,"allowedHosts":["ok.test"]}))
            .unwrap();
        assert_eq!(v, json!({"ok":false,"reason":"blocked"}), "{url}");
    }
    assert_eq!(w.site.log(), "");
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn the_browser_will_not_start_without_its_sandbox_and_namespace() {
    // Chromium's sandbox cannot start when nested namespaces are blocked, so the port reports
    // unsupported instead of running unsandboxed.
    let blocked = Launcher::new(chrome_dir()).blocking_nested_namespaces();
    let w = World::with(blocked.clone());
    let v = w.render("/news", &["ok.test"]);
    assert_eq!(v, json!({"ok":false,"reason":"unsupported"}), "{v}");
    drop(w);
    // Control: with the sandbox guard off, the same machine state renders, so the guard is what
    // stopped it.
    let w = World::with(blocked.without_chromium_sandbox());
    let v = w.render("/news", &["ok.test"]);
    println!("sandbox off and namespaces blocked: {v}");
    assert_eq!(v["ok"], true, "{v}");
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn a_missing_browser_reports_unsupported_and_opens_nothing() {
    let w = World::with(Launcher::new("/nonexistent-browser-folder"));
    let v = w.render("/news", &["ok.test"]);
    assert_eq!(v, json!({"ok":false,"reason":"unsupported"}));
    assert_eq!(w.site.log(), "");
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn caps_on_requests_response_size_total_bytes_and_time_hold() {
    let w = World::new();
    // More than 40 requests: the rest are refused.
    let v = w.render("/many", &["ok.test"]);
    assert_eq!(v["ok"], true, "{v}");
    let served = w.site.log().lines().filter(|l| l.contains("/s/")).count();
    assert!(served <= 40, "{served} page requests were served");
    assert!(v["requests"].as_u64().unwrap() > 40, "{v}");
    drop(w);
    // One response over 2 MB is refused.
    let w = World::new();
    let v = w.render("/huge", &["ok.test"]);
    assert_eq!(v["ok"], true, "{v}");
    assert!(v["text"].as_str().unwrap().contains("REFUSED"), "{v}");
    // Eight 1.8 MB responses: the 10 MB total ends the page's loading.
    let w = World::new();
    let v = w.render("/agg", &["ok.test"]);
    assert_eq!(v["ok"], true, "{v}");
    let text = v["text"].as_str().unwrap();
    assert!(text.matches('L').count() <= 5, "{text}");
    assert_eq!(text.matches('L').count() + text.matches('R').count(), 8, "{text}");
    // The host stops downloading once the total is spent, not only once the page stops loading.
    let downloaded = w.site.log().lines().filter(|l| l.contains("/chunk/")).count();
    assert!(downloaded <= 6, "{downloaded} of 8 large responses were downloaded");
    // A page whose script never answers ends at the call's deadline.
    CALL_SECONDS.store(4, Ordering::SeqCst);
    let w = World::new();
    let started = std::time::Instant::now();
    let v = w.render("/hangpage", &["ok.test"]);
    CALL_SECONDS.store(30, Ordering::SeqCst);
    assert_eq!(v, json!({"ok":false,"reason":"timeout"}), "{v}");
    assert!(started.elapsed() < Duration::from_secs(8), "{:?}", started.elapsed());
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn private_text_stays_out_of_activity_and_one_person_never_sees_anothers() {
    let w = World::new();
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let v = w
        .call(a, "route", json!({"url":"https://ok.test/news","allowedHosts":["ok.test"]}))
        .unwrap();
    assert_eq!(v["ok"], true);
    assert!(v["text"].as_str().unwrap().contains("Zebra-marker"));
    let mine = w.services.activity(&w.manifest.id, &AccessContext::new(a, "read")).unwrap();
    let theirs = w.services.activity(&w.manifest.id, &AccessContext::new(b, "read")).unwrap();
    let text = json!(mine).to_string();
    assert!(text.contains("\"browser\""), "{text}");
    for planted in ["Zebra-marker", "ok.test", "headlines", "Fixture Sports"] {
        assert!(!text.contains(planted), "activity recorded {planted}: {text}");
    }
    assert!(theirs.is_empty(), "A second person saw activity: {theirs:?}");
    drop(w);

    // Control: with every person's data pooled, the second person sees the first's row.
    let w = World::build(Launcher::new(chrome_dir()), Weakened::default(), false, true);
    w.call(a, "route", json!({"url":"https://ok.test/news","allowedHosts":["ok.test"]})).unwrap();
    let theirs = w.services.activity(&w.manifest.id, &AccessContext::new(b, "read")).unwrap();
    assert!(!theirs.is_empty(), "the control did not expose the row");
}

#[test]
#[ignore = "Needs the pinned browser (MOSS_BROWSER_DIR) and bubblewrap"]
fn the_returned_address_is_the_page_that_was_read_after_a_script_navigates() {
    let w = World::new();
    let v = w.render("/nav1", &["ok.test"]);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["title"], "Second page", "{v}");
    assert_eq!(v["finalUrl"], "https://ok.test/nav2", "{v}");
}
