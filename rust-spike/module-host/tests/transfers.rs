//! Actual stalled TLS handshakes, not a mocked transport or a timing sleep in production.
mod common;
use access_context::AccessContext;
use anyhow::{ensure, Result};
use moss_module_host::{
    lifecycle::FileLifecycle,
    local::LocalPorts,
    registry::Source,
    runtime::{Host, Limits},
    sql::LegacyInventory,
    store::{CatalogStore, Installer, State},
};
use std::{
    process::Command,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct MemoryCatalog(Mutex<State>);
impl CatalogStore for MemoryCatalog {
    fn load(&self) -> Result<State> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn commit(&self, revision: u64, next: &State) -> Result<()> {
        let mut old = self.0.lock().unwrap();
        ensure!(old.revision == revision, "Stale catalog");
        *old = next.clone();
        Ok(())
    }
}
struct Lease(String);
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = Command::new("devports").args(["release", &self.0]).output();
    }
}
fn stalled_transfer_keeps_module_callable(install: bool) {
    let data = tempfile::tempdir().unwrap();
    let registry = tempfile::tempdir().unwrap();
    let keys = common::Keys::new();
    let artifact = keys.write(registry.path(), "1.0.0", 1, vec![]);
    let actor = uuid::Uuid::new_v4();
    let access = AccessContext::new(actor, "slow-registry");
    let installer = Installer::new(
        data.path(),
        Arc::new(MemoryCatalog::default()),
        Arc::new(FileLifecycle::new(data.path(), [actor].into()).unwrap()),
        Host::new(Limits::default()).unwrap(),
        Arc::new(LocalPorts::new(data.path()).unwrap()),
        "0.1.0".parse().unwrap(),
        LegacyInventory::default(),
    )
    .unwrap();
    let root = common::Keys::public(&keys.root);
    let mut catalog = installer
        .refresh(
            &access,
            Source::Folder(registry.path().into()),
            &root,
            &root,
            "sample-registry",
        )
        .unwrap();
    installer
        .install(&access, &catalog, &artifact, true)
        .unwrap();
    let get = r#"{"operation":"get","resource":"counter"}"#;
    assert_eq!(
        installer
            .call("sample.counter", access.clone(), "route", get)
            .unwrap(),
        "null"
    );
    let claim = Command::new("devports")
        .args(["claim", "js43-transfer-proof"])
        .output()
        .unwrap();
    assert!(claim.status.success());
    let lease = Lease(String::from_utf8(claim.stdout).unwrap().trim().to_owned());
    let port: u16 = lease.0.parse().unwrap();
    assert!((5180..=5299).contains(&port));
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let source = Source::Https {
        base: format!("https://localhost:{port}/").parse().unwrap(),
        allow_private: true,
        certificate_pem: None,
    };
    catalog.source = source.clone();
    let (accepted_tx, accepted_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (call_tx, call_rx) = mpsc::channel();
    std::thread::scope(|threads| {
        threads.spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            accepted_tx.send(()).unwrap();
            // Deliberately hold the actual TLS handshake until the test releases it.
            let _ = release_rx.recv_timeout(Duration::from_secs(10));
            drop(socket);
        });
        let transfer = threads.spawn(|| {
            if install {
                installer.install(&access, &catalog, &artifact, true)
            } else {
                installer
                    .refresh(&access, source, &root, &root, "sample-registry")
                    .map(|_| ())
            }
        });
        accepted_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("registry did not connect");
        threads.spawn(|| {
            call_tx
                .send(installer.call("sample.counter", access.clone(), "route", get))
                .unwrap();
        });
        let response = call_rx.recv_timeout(Duration::from_secs(2));
        release_tx.send(()).unwrap();
        assert!(transfer.join().unwrap().is_err());
        assert_eq!(
            response
                .expect("a registry transfer blocked an installed module")
                .unwrap(),
            "null"
        );
    });
    println!(
        "PASS stalled {} over an actual socket: installed Wasm remains callable",
        if install {
            "package download"
        } else {
            "index refresh"
        }
    );
}
#[test]
#[ignore = "Explicit stalled-network proof: requires installed devports"]
fn stalled_registry_refresh_does_not_block_installed_modules() {
    stalled_transfer_keeps_module_callable(false);
}
#[test]
#[ignore = "Explicit stalled-network proof: requires installed devports"]
fn stalled_package_download_does_not_block_installed_modules() {
    stalled_transfer_keeps_module_callable(true);
}
