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
    assert!(
        !data.exists(),
        "proof must start without any instance folder"
    );
    let store = Store::new(data.clone());
    struct Cleanup<'a>(&'a std::path::Path, &'a Store);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            reach::stop_test_children(&self.1.servers_dir());
            let _ = provision::stop_database(self.0, &self.1.instance_folder("default"));
        }
    }
    let _cleanup = Cleanup(&install, &store);
    // The account's own profile can put the machine search path back, so the proof sets it here.
    if let Some(clean) = std::env::var_os("MOSS_PROOF_CLEAN_PATH") {
        std::env::set_var("PATH", clean);
    }
    let host_openssl = std::process::Command::new("openssl")
        .arg("version")
        .output();
    println!(
        "host openssl on the search path: {:?}",
        host_openssl.as_ref().map(|o| o.status.success())
    );
    if std::env::var_os("MOSS_PROOF_NO_HOST_OPENSSL").is_some() {
        assert!(
            host_openssl.is_err(),
            "the proof account must not see any host OpenSSL"
        );
        assert!(
            crate::launch::windows_openssl(&install).is_some(),
            "the install ships its own OpenSSL"
        );
        println!("setup runs with only the OpenSSL shipped inside the install");
    }
    provision::create_instance(&store, &install, "default").expect("app sets up a server");
    let folder = store.instance_folder("default");
    let config_path = folder.join("network.json");
    let mut config = Config::read(&config_path).unwrap();
    config.listen.set_port(port);
    config.origins = vec![format!("https://127.0.0.1:{port}")];
    config.write(&config_path).unwrap();
    assert!(
        database_running(&install, &folder),
        "database is up after setup"
    );
    for round in ["first start", "restart"] {
        let (running, certificate) = reach::local_or_start(&install, &folder)
            .await
            .unwrap_or_else(|e| panic!("{round}: server did not start: {}", e.reason()));
        assert!(!certificate.is_empty());
        assert_eq!(running.origin, format!("https://127.0.0.1:{port}"));
        assert!(
            reach::alive(running.pid),
            "{round}: server process is alive"
        );
        println!(
            "{round}: server up as process {} at {}",
            running.pid, running.origin
        );
        reach::stop_local(&install, &folder)
            .await
            .unwrap_or_else(|e| panic!("{round}: stop failed: {}", e.reason()));
        for _ in 0..40 {
            if !reach::alive(running.pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        assert!(
            !reach::alive(running.pid),
            "{round}: server process is gone"
        );
        assert!(
            reach::local(&folder).await.is_err(),
            "{round}: server no longer answers"
        );
        assert!(
            !database_running(&install, &folder),
            "{round}: database stopped too"
        );
        println!("{round}: stopped, server and database both gone");
    }
    println!("WINDOWS APP LIFECYCLE PROOF: setup, start, stop, restart, stop all passed");
    std::fs::remove_dir_all(data).unwrap();
}

/// The address this computer uses on its network, found without sending anything.
fn lan_address() -> std::net::Ipv4Addr {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").expect("udp socket");
    socket.connect("192.0.2.1:9").expect("route lookup");
    match socket.local_addr().expect("local address").ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() => ip,
        other => panic!("no network address on this computer: {other}"),
    }
}

/// A phone or laptop on the network reaches the server by this computer's network address.
/// This runs on one machine, so the connection comes from the same computer and does not test
/// the firewall, but it does test the listener, the certificate and the sharing switch.
#[tokio::test]
#[ignore = "requires a staged Windows install and a standard user"]
async fn windows_server_answers_on_the_network_address_only_when_sharing_is_on() {
    let install = PathBuf::from(std::env::var_os("MOSS_CLEAN_INSTALL").expect("staged install"));
    let data = PathBuf::from(std::env::var_os("MOSS_CLEAN_DATA").expect("new data folder"));
    let port: u16 = std::env::var("MOSS_PROOF_PORT").unwrap().parse().unwrap();
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
    let lan = lan_address();
    let lan_origin = format!("https://{lan}:{port}");
    config.listen = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    config.origins = vec![
        format!("https://localhost:{port}"),
        format!("https://127.0.0.1:{port}"),
        lan_origin.clone(),
    ];
    // A certificate that names the network address, made with the install's own OpenSSL.
    let tls = folder.join("tls-lan");
    moss_network::tls::local_certificate_with_command(
        &tls,
        &config.origins,
        crate::launch::command(&install, "openssl"),
    )
    .expect("certificate for the network address");
    config.certificate = tls.join("certificate.pem");
    config.private_key = tls.join("key.pem");
    config.sharing = false;
    config.write(&config_path).unwrap();
    println!("network address {lan_origin}");

    let (running, _) = reach::local_or_start(&install, &folder)
        .await
        .expect("server starts");
    let fingerprint = reach::peek_certificate(&lan_origin)
        .await
        .expect("certificate is readable over the network address");
    println!("sharing off: certificate readable over {lan_origin}, code {fingerprint}");
    let refused = reach::hello(&lan_origin, &fingerprint).await;
    assert!(
        matches!(refused, Err(reach::Problem::SharingOff)),
        "sharing off must refuse the network address"
    );
    println!("sharing off: the network address is refused with the sharing-off answer");
    reach::stop_local(&install, &folder).await.expect("stop");
    for _ in 0..40 {
        if !reach::alive(running.pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }

    config.sharing = true;
    config.write(&config_path).unwrap();
    let (running, _) = reach::local_or_start(&install, &folder)
        .await
        .expect("server restarts");
    let (hello, _) = reach::hello(&lan_origin, &fingerprint)
        .await
        .unwrap_or_else(|e| panic!("sharing on must accept the network address: {}", e.reason()));
    assert_eq!(hello.product, "moss");
    println!("sharing on: {lan_origin} answered the app's own connect check as a Moss server");
    reach::stop_local(&install, &folder).await.expect("stop");
    for _ in 0..40 {
        if !reach::alive(running.pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    println!("WINDOWS NETWORK ADDRESS PROOF: refused with sharing off, answered with sharing on");
    std::fs::remove_dir_all(data).unwrap();
}
