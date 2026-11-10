use crate::config::private_read;
use axum::{extract::ConnectInfo, Extension, Router};
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
};
use tokio::{
    net::TcpListener,
    sync::Semaphore,
    time::{timeout, Duration},
};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer},
    },
    TlsAcceptor,
};

pub fn acceptor(certificate: &Path, key: &Path) -> Result<TlsAcceptor, String> {
    let cert = std::fs::read(certificate).map_err(|_| "Cannot read the TLS certificate")?;
    if cert.len() > 1_048_576 {
        return Err("TLS certificate is too large".into());
    }
    let chain = CertificateDer::pem_slice_iter(&cert)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Invalid PEM certificate")?;
    let key = PrivateKeyDer::from_pem_slice(&private_read(key)?)
        .map_err(|_| "Invalid private TLS key")?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| "TLS versions unavailable")?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(|_| "Certificate and key do not match")?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Ctrl-C, or the termination signal the app and service managers send.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Native TLS; no plaintext listener and no forwarded-header trust path.
pub async fn serve(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    app: Router,
) -> Result<(), String> {
    // Remote connections cannot consume the owner's loopback reserve.
    let local_slots = Arc::new(Semaphore::new(32));
    let remote_slots = Arc::new(Semaphore::new(224));
    let mut connections = tokio::task::JoinSet::new();
    let stop = stop_signal();
    tokio::pin!(stop);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(connection) => connection,
                    Err(_) => { tokio::time::sleep(Duration::from_millis(100)).await; continue; }
                };
                let slots = if crate::policy::loopback(peer.ip()) { &local_slots } else { &remote_slots };
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                let acceptor = acceptor.clone();
                let app = app.clone().layer(Extension(ConnectInfo(peer)));
                connections.spawn(async move {
                    let _permit = permit;
                    let Ok(Ok(stream)) = timeout(Duration::from_secs(10), acceptor.accept(stream)).await else { return };
                    // Parser errors and handshake errors deliberately carry no request bytes to logs.
                    let _ = hyper::server::conn::http1::Builder::new()
                        .timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(15))
                        .max_buf_size(32 * 1024)
                        .serve_connection(TokioIo::new(stream), TowerToHyperService::new(app)).await;
                });
            }
        }
    }
    connections.abort_all();
    Ok(())
}

/// Uses the operator's installed OpenSSL. Does not install software or machine trust roots.
pub fn local_certificate(folder: &Path, origins: &[String]) -> Result<(), String> {
    local_certificate_with_command(folder, origins, Command::new("openssl"))
}

/// Uses an install-selected OpenSSL command, with the same certificate policy as the CLI.
/// The caller can select its bundled launcher without changing the process environment.
pub fn local_certificate_with_command(
    folder: &Path,
    origins: &[String],
    mut command: Command,
) -> Result<(), String> {
    let refs: Vec<_> = origins.iter().map(String::as_str).collect();
    crate::policy::Policy::new(&refs, false).map_err(str::to_owned)?;
    if folder.exists() {
        return Err("Choose a new private folder for the local certificate".into());
    }
    std::fs::create_dir(folder).map_err(|_| "Cannot create the local certificate folder")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect the certificate folder")?;
    }
    let mut sans = Vec::new();
    for origin in origins {
        let u = url::Url::parse(origin).map_err(|_| "Invalid certificate origin")?;
        let host = u
            .host_str()
            .ok_or("Missing certificate hostname")?
            .trim_matches(['[', ']']);
        // Restrict OpenSSL's extension syntax; no arbitrary config fragments.
        if !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b))
        {
            return Err("Invalid certificate hostname".into());
        }
        let kind = if host.parse::<std::net::IpAddr>().is_ok() {
            "IP"
        } else {
            "DNS"
        };
        sans.push(format!("{kind}:{host}"));
    }
    let key = folder.join("key.pem");
    let cert = folder.join("certificate.pem");
    let status = command.args(["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "30", "-subj", "/CN=Moss local", "-addext", &format!("subjectAltName={}", sans.join(",")), "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth", "-keyout"])
        .arg(&key).arg("-out").arg(&cert).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|_| "Local certificates need the installed OpenSSL command; alternatively supply a certificate and key")?;
    if !status.success() {
        return Err("Could not make a local certificate".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for p in [&key, &cert] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Cannot protect the certificate files")?;
        }
    }
    acceptor(&cert, &key)?;
    Ok(())
}
