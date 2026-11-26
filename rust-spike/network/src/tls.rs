use crate::config::private_read;
use axum::{extract::ConnectInfo, Extension, Router};
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
};
use tokio::{
    net::{TcpListener, TcpStream},
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

/// The file the app writes into a server's instance folder to ask it to stop where there is no
/// termination signal (Windows). It must hold the server's process id, so a leftover request
/// from an earlier run never stops a newer server.
pub const STOP_FILE: &str = "stop-request";

/// Resolves when a stop request naming this process appears. Never resolves without a folder.
async fn stop_requested(folder: Option<&Path>) {
    let Some(folder) = folder else {
        return std::future::pending().await;
    };
    let path = folder.join(STOP_FILE);
    loop {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let Ok(bytes) = private_read(&path) else {
            continue;
        };
        let _ = std::fs::remove_file(&path);
        let named = String::from_utf8_lossy(&bytes).trim().parse::<u32>().ok();
        if named == Some(std::process::id()) {
            return;
        }
    }
}

/// The sockets the server accepts on. With sharing off only loopback is bound, so no other
/// device can open a connection at all. Turning sharing on binds `shared` instead.
pub struct Listening {
    listeners: Vec<TcpListener>,
    binder: Option<Binder>,
    port: u16,
    sharing: bool,
    switch: tokio::sync::mpsc::Receiver<(bool, Reply)>,
}

#[derive(Clone)]
struct Binder {
    shared: SocketAddr,
}

impl Binder {
    /// The addresses for one sharing state. Port 0 picks one port and reuses it.
    async fn bind(&self, sharing: bool) -> Result<Vec<TcpListener>, String> {
        let mut found = Vec::new();
        let mut port = self.shared.port();
        let mut addrs = Vec::new();
        if sharing {
            addrs.push(self.shared.ip());
        }
        // A specific shared address leaves loopback to its own socket.
        if !sharing || !self.shared.ip().is_unspecified() {
            addrs.push(Ipv4Addr::LOCALHOST.into());
            addrs.push(Ipv6Addr::LOCALHOST.into());
        }
        addrs.dedup();
        for ip in addrs {
            match TcpListener::bind(SocketAddr::new(ip, port)).await {
                Ok(l) => {
                    if port == 0 {
                        port = l
                            .local_addr()
                            .map_err(|_| "Cannot read the listening port")?
                            .port();
                    }
                    found.push(l);
                }
                // Only the IPv6 loopback may be missing on a machine without IPv6.
                Err(_) if ip == IpAddr::V6(Ipv6Addr::LOCALHOST) && !found.is_empty() => {}
                Err(_) => return Err("Cannot bind the configured HTTPS listener".into()),
            }
        }
        Ok(found)
    }
}

type Reply = tokio::sync::oneshot::Sender<Result<(), String>>;

/// Asks the running server to change what it binds.
#[derive(Clone)]
pub struct ListenSwitch {
    tx: tokio::sync::mpsc::Sender<(bool, Reply)>,
}

impl ListenSwitch {
    pub async fn set(&self, sharing: bool) -> Result<(), String> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.tx
            .send((sharing, reply))
            .await
            .map_err(|_| "The server is not accepting connections")?;
        answer
            .await
            .map_err(|_| "The server is not accepting connections")?
    }
}

impl Listening {
    pub async fn bind(listen: SocketAddr, sharing: bool) -> Result<(Self, ListenSwitch), String> {
        let mut binder = Binder { shared: listen };
        let listeners = binder.bind(sharing).await?;
        let port = listeners[0]
            .local_addr()
            .map_err(|_| "Cannot read the listening port")?
            .port();
        binder.shared.set_port(port);
        let (tx, switch) = tokio::sync::mpsc::channel(4);
        Ok((
            Listening {
                listeners,
                binder: Some(binder),
                port,
                sharing,
                switch,
            },
            ListenSwitch { tx },
        ))
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

/// Native TLS; no plaintext listener and no forwarded-header trust path.
pub async fn serve(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    app: Router,
) -> Result<(), String> {
    serve_in(listener, acceptor, app, None).await
}

/// Like `serve`, and also stops when the app writes a stop request into `folder`.
pub async fn serve_in(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    app: Router,
    folder: Option<&Path>,
) -> Result<(), String> {
    let port = listener
        .local_addr()
        .map_err(|_| "Cannot read the listening port")?
        .port();
    let (_, switch) = tokio::sync::mpsc::channel(1);
    let listening = Listening {
        listeners: vec![listener],
        binder: None,
        port,
        sharing: false,
        switch,
    };
    serve_switched(listening, acceptor, app, folder).await
}

fn accept_on(
    listener: TcpListener,
    tx: tokio::sync::mpsc::Sender<(TcpStream, SocketAddr)>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok(connection) => {
                    if tx.send(connection).await.is_err() {
                        return;
                    }
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    })
}

/// Serves on `listening` and rebinds when the switch asks.
pub async fn serve_switched(
    listening: Listening,
    acceptor: TlsAcceptor,
    app: Router,
    folder: Option<&Path>,
) -> Result<(), String> {
    // A request left by an earlier run could name a reused process number.
    if let Some(folder) = folder {
        let _ = std::fs::remove_file(folder.join(STOP_FILE));
    }
    // Remote connections cannot consume the owner's loopback reserve.
    let local_slots = Arc::new(Semaphore::new(32));
    let remote_slots = Arc::new(Semaphore::new(224));
    let mut connections = tokio::task::JoinSet::new();
    let (tx, mut accepted) = tokio::sync::mpsc::channel(64);
    let binder = listening.binder.clone();
    let mut switch = listening.switch;
    let mut bound = Some(listening.sharing);
    let mut sockets: Vec<_> = listening
        .listeners
        .into_iter()
        .map(|l| accept_on(l, tx.clone()))
        .collect();
    let stop = async {
        tokio::select! { _ = stop_signal() => {}, _ = stop_requested(folder) => {} }
    };
    tokio::pin!(stop);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            Some((sharing, reply)) = switch.recv() => {
                // A request for the state already held changes nothing.
                if Some(sharing) == bound {
                    let _ = reply.send(Ok(()));
                    continue;
                }
                // Close every socket first, so the new set can reuse the port.
                for socket in sockets.drain(..) {
                    socket.abort();
                    let _ = socket.await;
                }
                let result = match &binder {
                    Some(binder) => rebind(binder, sharing, &tx).await,
                    None => Err("This server cannot change its sockets".to_owned()),
                };
                match result {
                    Ok(next) => { sockets = next; bound = Some(sharing); let _ = reply.send(Ok(())); }
                    Err(reason) => {
                        // Return to the earlier state rather than stop accepting.
                        if let Some(binder) = &binder {
                            // With no sockets left, the held state is unknown and the next request rebinds.
                            let held = bound.take();
                            if let Some(held) = held {
                                if let Ok(back) = rebind(binder, held, &tx).await { sockets = back; bound = Some(held); }
                            }
                        }
                        let _ = reply.send(Err(reason));
                    }
                }
            }
            Some((stream, peer)) = accepted.recv() => {
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
    for socket in sockets {
        socket.abort();
    }
    connections.abort_all();
    Ok(())
}

async fn rebind(
    binder: &Binder,
    sharing: bool,
    tx: &tokio::sync::mpsc::Sender<(TcpStream, SocketAddr)>,
) -> Result<Vec<tokio::task::JoinHandle<()>>, String> {
    let listeners = binder.bind(sharing).await?;
    Ok(listeners
        .into_iter()
        .map(|l| accept_on(l, tx.clone()))
        .collect())
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
