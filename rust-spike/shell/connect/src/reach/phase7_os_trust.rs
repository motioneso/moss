//! Real TLS against a CA installed by the runner into the platform's trust store.
use super::*;
use axum::{routing::get, Json, Router};
use moss_network::instance;

async fn server(name: &str) -> String {
    let fixtures =
        PathBuf::from(std::env::var_os("MOSS_OS_TRUST_FIXTURES").expect("use phase7_os_trust.py"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!(
        "https://127.0.0.1:{}",
        listener.local_addr().unwrap().port()
    );
    let acceptor = moss_network::tls::acceptor(
        &fixtures.join(format!("{name}.pem")),
        &fixtures.join(format!("{name}.key")),
    )
    .unwrap();
    let app = Router::new().route("/api/hello", get(|| async { Json(instance::hello()) }));
    tokio::spawn(moss_network::tls::serve(listener, acceptor, app));
    origin
}

#[tokio::test]
#[ignore = "runner installs and removes a disposable CA in the OS trust store"]
async fn phase7_os_trust() {
    let origin = server("valid").await;
    let (hello, _) = super::hello(&origin, "")
        .await
        .expect("OS-trusted CA connects WITHOUT a pin");
    assert_eq!(hello, instance::hello());
    assert!(
        has_os_trust(&origin).await,
        "public discovery chooses OS trust"
    );
    let fixtures = PathBuf::from(std::env::var_os("MOSS_OS_TRUST_FIXTURES").unwrap());
    let store = crate::store::Store::new(fixtures.join("saved-profile"));
    let public = crate::store::Remote {
        id: "public".into(),
        name: "public".into(),
        origin: origin.clone(),
        pin: String::new(),
    };
    store
        .save(&crate::store::Servers {
            last: Some(public.id.clone()),
            remotes: vec![public],
        })
        .unwrap();
    let saved = store.load().unwrap().remotes.remove(0);
    assert!(
        saved.pin.is_empty(),
        "public profiles must not acquire a leaf pin"
    );
    assert!(super::hello(&saved.origin, &saved.pin).await.is_ok());
    // Notifier requests must use the same OS trust policy, rather than pinning the first leaf.
    assert_eq!(
        request(&origin, "", "GET", "/api/hello", "fixture", None)
            .await
            .unwrap()
            .0,
        200
    );
    let renewed = server("renewed").await;
    assert!(
        super::hello(&renewed, "").await.is_ok(),
        "CA renewal needs no comparison"
    );
    println!("PASS: OS-trusted CA hello, notifier request and renewal without pinning");

    for name in ["wrong-host", "expired", "untrusted"] {
        let origin = server(name).await;
        assert!(
            !has_os_trust(&origin).await,
            "invalid {name} certificate selected OS trust"
        );
        assert!(
            super::hello(&origin, "").await.is_err(),
            "invalid {name} certificate was accepted"
        );
        assert!(request(&origin, "", "GET", "/api/hello", "fixture", None)
            .await
            .is_err());
        println!("PASS: {name} refused without a pin");
    }

    let original = server("self-signed").await;
    let pin = peek_certificate(&original).await.unwrap();
    assert!(super::hello(&original, &pin).await.is_ok());
    let changed = server("changed-self-signed").await;
    let changed_code = peek_certificate(&changed).await.unwrap();
    let warning = Problem::CertificateChanged {
        fingerprint: changed_code,
    };
    assert_eq!(super::hello(&changed, &pin).await, Err(warning.clone()));
    assert_eq!(
        request(&changed, &pin, "GET", "/api/hello", "fixture", None).await,
        Err(warning)
    );
    assert!(super::hello(&changed, "").await.is_err());
    // Even a CA-signed replacement cannot override an existing pin.
    assert!(matches!(
        super::hello(&renewed, &pin).await,
        Err(Problem::CertificateChanged { .. })
    ));
    println!("PASS: changed self-signed certificate retains app_certificate_changed; OS trust cannot override pins");
}

#[tokio::test]
#[ignore = "runner invokes this only after revoking its disposable CA"]
async fn phase7_os_trust_after_cleanup() {
    let origin = server("valid").await;
    assert!(
        !has_os_trust(&origin).await,
        "disposable CA is still trusted after cleanup"
    );
    println!("PASS: disposable CA is no longer trusted after cleanup");
}
