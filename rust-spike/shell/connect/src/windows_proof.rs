//! Real Windows lifecycle proof, run by the Windows CI workflow as a standard user.
use crate::{provision, reach, store::Store};
use moss_network::config::Config;
use std::path::PathBuf;

fn database_running(install: &std::path::Path, folder: &std::path::Path) -> bool {
    let out = std::process::Command::new(install.join("moss-db.exe"))
        .args(["status", "--root"])
        .arg(folder.join("database"))
        .output()
        .expect("moss-db status");
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).expect("status json");
    value["supervisor_pid"].is_u64()
}

#[tokio::test]
#[ignore = "requires a staged Windows install and a standard user"]
async fn windows_app_provisions_starts_stops_and_restarts_the_whole_server() {
    let install = PathBuf::from(std::env::var_os("MOSS_CLEAN_INSTALL").expect("staged install"));
    let data = PathBuf::from(std::env::var_os("MOSS_CLEAN_DATA").expect("new data folder"));
    let port: u16 = std::env::var("MOSS_PROOF_PORT").unwrap().parse().unwrap();
    assert!(!data.exists(), "proof must start without any instance folder");
    let store = Store::new(data.clone());
    struct Cleanup<'a>(&'a std::path::Path, &'a Store);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            reach::stop_test_children(&self.1.servers_dir());
            let _ = provision::stop_database(self.0, &self.1.instance_folder("default"));
        }
    }
    let _cleanup = Cleanup(&install, &store);
    provision::create_instance(&store, &install, "default").expect("app sets up a server");
    let folder = store.instance_folder("default");
    let config_path = folder.join("network.json");
    let mut config = Config::read(&config_path).unwrap();
    config.listen.set_port(port);
    config.origins = vec![format!("https://127.0.0.1:{port}")];
    config.write(&config_path).unwrap();
    assert!(database_running(&install, &folder), "database is up after setup");
    for round in ["first start", "restart"] {
        let (running, certificate) = reach::local_or_start(&install, &folder)
            .await
            .unwrap_or_else(|e| panic!("{round}: server did not start: {}", e.reason()));
        assert!(!certificate.is_empty());
        assert_eq!(running.origin, format!("https://127.0.0.1:{port}"));
        assert!(reach::alive(running.pid), "{round}: server process is alive");
        println!("{round}: server up as process {} at {}", running.pid, running.origin);
        reach::stop_local(&install, &folder)
            .await
            .unwrap_or_else(|e| panic!("{round}: stop failed: {}", e.reason()));
        for _ in 0..40 {
            if !reach::alive(running.pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        assert!(!reach::alive(running.pid), "{round}: server process is gone");
        assert!(reach::local(&folder).await.is_err(), "{round}: server no longer answers");
        assert!(!database_running(&install, &folder), "{round}: database stopped too");
        println!("{round}: stopped, server and database both gone");
    }
    println!("WINDOWS APP LIFECYCLE PROOF: setup, start, stop, restart, stop all passed");
    std::fs::remove_dir_all(data).unwrap();
}
