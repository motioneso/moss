use super::*;
use axum::{http::HeaderMap, routing::get, Json, Router};
use moss_network::instance::{self, leaf_der};
use serde_json::json;
use std::path::PathBuf;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("moss-app-{tag}-{}", uuid::Uuid::new_v4()));
    crate::store::private_dir(&dir).unwrap();
    dir
}

/// A real TLS listener with a fresh self-signed certificate for 127.0.0.1 only.
async fn server(app: Router) -> (String, String, PathBuf) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!(
        "https://127.0.0.1:{}",
        listener.local_addr().unwrap().port()
    );
    let dir = scratch("tls");
    let certs = dir.join("certs");
    moss_network::tls::local_certificate(&certs, std::slice::from_ref(&origin)).unwrap();
    let cert = certs.join("certificate.pem");
    let acceptor = moss_network::tls::acceptor(&cert, &certs.join("key.pem")).unwrap();
    let pin = instance::fingerprint(&leaf_der(&std::fs::read(&cert).unwrap()).unwrap());
    tokio::spawn(moss_network::tls::serve(listener, acceptor, app));
    (origin, pin, dir)
}

fn moss() -> Router {
    Router::new().route(
        "/api/hello",
        get(|headers: HeaderMap| async move {
            let host = headers
                .get("host")
                .and_then(|h| h.to_str().ok())
                .unwrap_or_default();
            if host.starts_with("127.0.0.1:") {
                (axum::http::StatusCode::OK, Json(json!(instance::hello())))
            } else {
                (
                    axum::http::StatusCode::MISDIRECTED_REQUEST,
                    Json(json!({"code":"host_refused"})),
                )
            }
        }),
    )
}

#[test]
fn addresses_must_be_bare_https_origins() {
    assert_eq!(
        parse_origin(" 192.168.1.20:5201 ").unwrap(),
        "https://192.168.1.20:5201"
    );
    assert_eq!(
        parse_origin("https://moss.example/").unwrap(),
        "https://moss.example"
    );
    for bad in [
        "http://192.168.1.20:5201",
        "https://h/x",
        "https://h?q",
        "https://u@h",
        "https://",
        "ftp://h",
    ] {
        assert!(parse_origin(bad).is_err(), "{bad} was accepted");
    }
    assert!(is_loopback_origin("https://127.0.0.1:5201"));
    assert!(is_loopback_origin("https://[::1]:5201"));
    assert!(!is_loopback_origin("https://192.168.1.20:5201"));
    assert!(!is_loopback_origin("http://127.0.0.1:5201"));
}

#[test]
fn versions_must_share_an_api_number() {
    let range = |oldest, current| ApiRange { current, oldest };
    assert_eq!(compatible(SUPPORTED), Ok(()));
    assert_eq!(compatible(range(0, 0)), Err(Problem::ServerTooOld));
    assert_eq!(
        compatible(range(SUPPORTED.current + 1, SUPPORTED.current + 2)),
        Err(Problem::AppTooOld)
    );
}

#[tokio::test]
async fn pins_accept_only_the_confirmed_certificate() {
    let (origin, pin, dir) = server(moss()).await;
    assert_eq!(peek_certificate(&origin).await.unwrap(), pin);
    let (hello, der) = hello(&origin, &pin).await.unwrap();
    assert_eq!(hello, instance::hello());
    assert_eq!(instance::fingerprint(&der), pin);

    let wrong = instance::fingerprint(b"another certificate");
    assert_eq!(
        super::hello(&origin, &wrong).await,
        Err(Problem::CertificateChanged {
            fingerprint: pin.clone()
        })
    );

    // The pin replaces name checks, so the server's own Host rule is what refuses this address.
    let other_name = origin.replace("127.0.0.1", "localhost");
    assert_eq!(
        super::hello(&other_name, &pin).await,
        Err(Problem::HostRefused)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn refusals_and_strangers_are_named() {
    let sharing_off = Router::new().route(
        "/api/hello",
        get(|| async {
            (
                axum::http::StatusCode::FORBIDDEN,
                Json(json!({"code":"origin_or_sharing_refused"})),
            )
        }),
    );
    let (origin, pin, dir) = server(sharing_off).await;
    assert_eq!(hello(&origin, &pin).await, Err(Problem::SharingOff));
    std::fs::remove_dir_all(dir).unwrap();

    let stranger = Router::new().route(
        "/api/hello",
        get(|| async {
            Json(json!({"product":"other","version":"1","api":{"current":1,"oldest":1}}))
        }),
    );
    let (origin, pin, dir) = server(stranger).await;
    assert_eq!(hello(&origin, &pin).await, Err(Problem::NotMoss));
    std::fs::remove_dir_all(dir).unwrap();

    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = closed.local_addr().unwrap().port();
    drop(closed);
    assert_eq!(
        peek_certificate(&format!("https://127.0.0.1:{port}")).await,
        Err(Problem::Unreachable)
    );
}

#[tokio::test]
async fn running_file_is_trusted_only_when_current_and_private() {
    let (origin, pin, dir) = server(moss()).await;
    let folder = dir.join("default");
    crate::store::private_dir(&folder).unwrap();
    assert_eq!(local(&folder).await.unwrap_err(), Problem::NotSetUp);
    std::fs::write(folder.join(NETWORK_FILE), b"{}").unwrap();

    let good = Running {
        instance: "default".into(),
        origin: origin.clone(),
        fingerprint: pin.clone(),
        pid: std::process::id(),
        version: instance::VERSION.into(),
        api: instance::API,
    };
    good.write(&folder).unwrap();
    let (found, der) = local(&folder).await.unwrap();
    assert_eq!(found, good);
    assert_eq!(instance::fingerprint(&der), pin);

    let cases = [
        Running {
            pid: 4_000_000_000,
            ..good.clone()
        },
        Running {
            origin: origin.replace("127.0.0.1", "192.168.1.20"),
            ..good.clone()
        },
        Running {
            fingerprint: instance::fingerprint(b"stale"),
            ..good.clone()
        },
    ];
    for bad in cases {
        bad.write(&folder).unwrap();
        assert_eq!(
            local(&folder).await.unwrap_err(),
            Problem::Unreachable,
            "{bad:?}"
        );
    }

    good.write(&folder).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let file = folder.join(instance::RUNNING_FILE);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(local(&folder).await.unwrap_err(), Problem::Unreachable);
    }
    std::fs::remove_dir_all(dir).unwrap();
}
