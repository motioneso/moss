use super::*;
use axum::{http::HeaderMap, routing::get, Json, Router};
use moss_network::instance::{self, leaf_der};
use serde_json::json;
use std::path::PathBuf;

#[test]
fn local_start_lock_serializes_independent_app_handles() {
    let dir = scratch("start-lock");
    let first = start_lock(&dir).unwrap().expect("first app owns start");
    assert!(start_lock(&dir).unwrap().is_none());
    drop(first);
    assert!(start_lock(&dir).unwrap().is_some());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn local_start_lock_errors_are_not_reported_as_a_busy_app() {
    let dir = scratch("bad-lock");
    std::fs::create_dir(dir.join("start.lock")).unwrap();
    assert_eq!(start_lock(&dir).unwrap_err(), Problem::DidNotStart);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn server_program_uses_the_platform_executable_suffix() {
    let install = Path::new("installation with spaces");
    let command = crate::launch::command(install, "moss-shell");
    let program = Path::new(command.get_program());
    assert_eq!(program.parent(), Some(install));
    assert_eq!(program.file_stem().unwrap(), "moss-shell");
    #[cfg(windows)]
    assert_eq!(program.extension().unwrap(), "exe");
    #[cfg(unix)]
    assert!(program.extension().is_none());
}

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
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        local(&folder).await.unwrap();

        // A folder others can write to is not trusted, even with a private file inside.
        for writable in [&folder, &dir] {
            std::fs::set_permissions(writable, std::fs::Permissions::from_mode(0o770)).unwrap();
            assert_eq!(local(&folder).await.unwrap_err(), Problem::Unreachable);
            assert!(crate::store::private_dir(writable).is_err());
            std::fs::set_permissions(writable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        local(&folder).await.unwrap();
    }
    std::fs::remove_dir_all(dir).unwrap();
}

/// A server that stops while starting is noticed at once, and two callers start it only once.
#[cfg(unix)]
#[tokio::test]
async fn a_server_is_started_once_and_a_stopped_start_fails_fast() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("start");
    let install = dir.join("install");
    crate::store::private_dir(&install).unwrap();
    let shell = install.join("moss-shell");
    std::fs::write(
        &shell,
        "#!/bin/sh\necho started >> \"$3/starts\"\nsleep 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
    let folder = dir.join("default");
    crate::store::private_dir(&folder).unwrap();
    std::fs::write(folder.join(NETWORK_FILE), b"{}").unwrap();
    let starts = || {
        std::fs::read_to_string(folder.join("starts"))
            .unwrap_or_default()
            .lines()
            .count()
    };

    let begun = std::time::Instant::now();
    let (a, b) = tokio::join!(
        local_or_start(&install, &folder),
        local_or_start(&install, &folder)
    );
    assert_eq!(a.unwrap_err(), Problem::DidNotStart);
    assert_eq!(b.unwrap_err(), Problem::DidNotStart);
    assert!(
        begun.elapsed() < Duration::from_secs(10),
        "waited out the full start time"
    );
    assert_eq!(starts(), 1);

    assert_eq!(
        local_or_start(&install, &folder).await.unwrap_err(),
        Problem::DidNotStart
    );
    assert_eq!(starts(), 2, "a later try starts it again");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn stop_waits_for_a_connect_that_holds_the_start_lock() {
    let dir = scratch("stop-lock");
    let guard = start_lock(&dir).unwrap().unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), stop_local(&dir, &dir))
            .await
            .is_err(),
        "Stop must wait until the in-progress start completes"
    );
    drop(guard);
    assert!(stop_local(&dir, &dir).await.is_err());
    std::fs::remove_dir_all(dir).unwrap();
}

/// An unresponsive server is not evidence that it is safe to stop its database.
#[cfg(unix)]
#[tokio::test]
async fn stop_refuses_to_stop_the_database_without_a_reachable_server() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("stop-unreachable");
    std::fs::write(dir.join(NETWORK_FILE), b"{}").unwrap();
    let install = dir.join("install");
    crate::store::private_dir(&install).unwrap();
    crate::store::private_dir(&dir.join(crate::provision::DATABASE_FOLDER)).unwrap();
    let supervisor = install.join("moss-db");
    std::fs::write(&supervisor, "#!/bin/sh\ntouch \"$3/stopped\"\n").unwrap();
    std::fs::set_permissions(&supervisor, std::fs::Permissions::from_mode(0o700)).unwrap();
    let result = stop_local(&install, &dir).await;
    assert_eq!(result, Err(Problem::Unreachable));
    assert!(!dir
        .join(crate::provision::DATABASE_FOLDER)
        .join("stopped")
        .exists());
    std::fs::remove_dir_all(dir).unwrap();
}

/// The Windows stop route: a request file naming the server's process id ends the server, and
/// a request naming another process (a leftover from an earlier run) does not.
#[tokio::test]
async fn stop_request_file_ends_only_the_server_it_names() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("https://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let dir = scratch("stop-file");
    let certs = dir.join("certs");
    moss_network::tls::local_certificate(&certs, std::slice::from_ref(&origin)).unwrap();
    let acceptor =
        moss_network::tls::acceptor(&certs.join("certificate.pem"), &certs.join("key.pem")).unwrap();
    let folder = dir.clone();
    let mut served = tokio::spawn(async move {
        moss_network::tls::serve_in(listener, acceptor, moss(), Some(&folder)).await
    });
    super::request_stop_by_file(&dir, std::process::id() + 1).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(900), &mut served).await.is_err(),
        "a request for another process must not stop this server"
    );
    assert!(!dir.join(moss_network::tls::STOP_FILE).exists(), "the request is consumed");
    super::request_stop_by_file(&dir, std::process::id()).unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(5), served).await;
    assert!(matches!(ended, Ok(Ok(Ok(())))), "the named server stops");
    std::fs::remove_dir_all(dir).unwrap();
}
