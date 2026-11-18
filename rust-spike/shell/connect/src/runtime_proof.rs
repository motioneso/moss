//! Real staged lifecycle proof, run only through the isolated project gate.
use crate::{provision, reach, store::Store};
use moss_network::config::Config;
use std::path::PathBuf;

#[tokio::test]
#[ignore = "requires a staged install, a claimed port, and verify-gate"]
async fn staged_runtime_provisions_starts_and_stops_local_server() {
    assert_eq!(std::env::var("JARVIS_GATE_RUN").as_deref(), Ok("1"));
    let install = PathBuf::from(std::env::var_os("MOSS_CLEAN_INSTALL").expect("staged install"));
    let data = PathBuf::from(std::env::var_os("MOSS_CLEAN_DATA").expect("new data folder"));
    let port: u16 = std::env::var("MOSS_PROOF_PORT").unwrap().parse().unwrap();
    assert!((5180..=5299).contains(&port), "claim a task devports port");
    assert!(
        !data.exists(),
        "proof must start without any instance folder"
    );
    assert!(install.join("runtime/closure.json").is_file());
    let store = Store::new(data.clone());
    // Always stop supervisors on an assertion failure; proof data is task-owned and disposable.
    struct Cleanup<'a>(&'a std::path::Path, &'a Store);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            reach::stop_test_children(&self.1.servers_dir());
            for name in ["default", "second"] {
                let _ = provision::stop_database(self.0, &self.1.instance_folder(name));
            }
        }
    }
    let _cleanup = Cleanup(&install, &store);
    for name in ["default", "second"] {
        provision::create_instance(&store, &install, name).expect("real staged provisioning");
        let folder = store.instance_folder(name);
        let config_path = folder.join("network.json");
        let mut config = Config::read(&config_path).unwrap();
        // Provisioning reserves its normal product port but starts no listener. The proof
        // uses its single claimed dev port, sequentially for the two independent instances.
        config.listen.set_port(port);
        config.origins = vec![format!("https://127.0.0.1:{port}")];
        config.write(&config_path).unwrap();
        let (running, certificate) = reach::local_or_start(&install, &folder)
            .await
            .expect("app starts real local server and verifies hello");
        assert!(!certificate.is_empty());
        assert_eq!(running.origin, format!("https://127.0.0.1:{port}"));
        assert_eq!(
            std::fs::read_link(format!("/proc/{}/exe", running.pid)).unwrap(),
            install.join("moss-shell")
        );
        let maps = std::fs::read_to_string(format!("/proc/{}/maps", running.pid)).unwrap();
        assert!(maps
            .lines()
            .any(|line| line.contains(&format!("{}/runtime/lib/libc.so.6", install.display()))));
        reach::stop_local(&install, &folder)
            .await
            .expect("orderly Stop");
        println!(
            "PASS: {name}: app provisioning, bundled OpenSSL/PostgreSQL, HTTPS hello and Stop"
        );
    }
    std::fs::remove_dir_all(data).unwrap();
}
