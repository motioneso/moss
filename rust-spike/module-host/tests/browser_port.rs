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
    browser::launch::{Isolation, Launcher},
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
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
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
        let listener = Listener::start();
        let site = Site::start(listener.port);
        let data = tempfile::tempdir().unwrap();
        let web = PublicWeb::new(site.resolver(), Some(site.pem.clone()), Duration::ZERO);
        let services = Arc::new(
            ServicePorts::new(
                data.path(),
                Arc::new(SecretCipher::connectors(&Default::default()).unwrap()),
                Arc::new(NoAi),
                Arc::new(LocalPorts::new(data.path()).unwrap()),
            )
            .unwrap()
            .with_public_web(web)
            .with_browser_launcher(launcher),
        );
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
                deadline: Duration::from_secs(30),
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
