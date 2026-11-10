//! Reaching a server: address checks, certificate pins, hello and the local running file.

use moss_network::instance::{fingerprint, ApiRange, Hello, Running, NETWORK_FILE, RUNNING_FILE};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::rustls::{
    self,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use tokio_rustls::TlsConnector;

/// The native API numbers this app can talk to.
pub const SUPPORTED: ApiRange = ApiRange {
    current: 1,
    oldest: 1,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    NotSetUp,
    DidNotStart,
    Unreachable,
    HostRefused,
    SharingOff,
    NotMoss,
    CertificateChanged { fingerprint: String },
    ServerTooOld,
    AppTooOld,
}

impl Problem {
    /// The error code the app map declares for this problem.
    pub fn code(&self) -> &'static str {
        match self {
            Problem::NotSetUp => "app_server_not_set_up",
            Problem::DidNotStart => "app_server_did_not_start",
            Problem::Unreachable => "app_server_unreachable",
            Problem::HostRefused => "host_refused",
            Problem::SharingOff => "origin_or_sharing_refused",
            Problem::NotMoss => "app_not_a_moss_server",
            Problem::CertificateChanged { .. } => "app_certificate_changed",
            Problem::ServerTooOld => "app_server_too_old",
            Problem::AppTooOld => "app_too_old",
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Problem::NotSetUp => "Moss isn't set up on this computer yet.",
            Problem::DidNotStart => "Moss didn't start on this computer.",
            Problem::Unreachable => "Moss isn't answering at this address.",
            Problem::HostRefused => {
                "That computer doesn't list this address. Use one from its Sharing screen."
            }
            Problem::SharingOff => "Sharing is off on that computer.",
            Problem::NotMoss => "This address isn't a Moss server.",
            Problem::CertificateChanged { .. } => "The certificate changed.",
            Problem::ServerTooOld => "Update Moss on that computer.",
            Problem::AppTooOld => "Update this app.",
        }
    }
}

/// Accepts `host[:port]` or an `https://` origin. Paths, queries, user names and `http` are
/// refused. Returns the normalised origin.
pub fn parse_origin(input: &str) -> Result<String, &'static str> {
    let input = input.trim();
    let with_scheme = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = url::Url::parse(&with_scheme)
        .map_err(|_| "Enter an address like https://192.168.1.20:5201")?;
    if url.scheme() != "https" {
        return Err("Moss addresses start with https://");
    }
    if url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Enter only the address, without a path");
    }
    Ok(url.origin().ascii_serialization())
}

pub fn is_loopback_origin(origin: &str) -> bool {
    url::Url::parse(origin).is_ok_and(|u| {
        u.scheme() == "https"
            && match u.host() {
                Some(url::Host::Domain(d)) => d == "localhost",
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            }
    })
}

/// Records the leaf certificate and, when pinned, accepts only that exact leaf. The server must
/// still prove it holds the certificate's key through the normal handshake signature. Validity
/// dates are ignored on purpose: a renewed certificate is a new leaf and is asked about again.
#[derive(Debug)]
struct Pin {
    expected: Option<String>,
    seen: Arc<Mutex<Option<Vec<u8>>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        *self.seen.lock().expect("pin lock") = Some(end_entity.as_ref().to_vec());
        match &self.expected {
            Some(pin) if *pin != fingerprint(end_entity.as_ref()) => {
                Err(rustls::Error::General("certificate pin mismatch".into()))
            }
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

type Tls = tokio_rustls::client::TlsStream<TcpStream>;

/// Opens TLS to an origin. `Err(Some(der))` means the certificate did not match the pin.
async fn open(origin: &str, pin: Option<&str>) -> Result<(Tls, Vec<u8>), Result<Vec<u8>, Problem>> {
    let url = url::Url::parse(origin).map_err(|_| Err(Problem::NotMoss))?;
    let host = url
        .host_str()
        .ok_or(Err(Problem::NotMoss))?
        .trim_matches(['[', ']'])
        .to_owned();
    let port = url.port_or_known_default().ok_or(Err(Problem::NotMoss))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let seen = Arc::new(Mutex::new(None));
    let verifier = Pin {
        expected: pin.map(str::to_owned),
        seen: seen.clone(),
        provider: provider.clone(),
    };
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| Err(Problem::NotMoss))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let name = ServerName::try_from(host.clone()).map_err(|_| Err(Problem::NotMoss))?;
    let tcp = timeout(
        Duration::from_secs(5),
        TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| Err(Problem::Unreachable))?
    .map_err(|_| Err(Problem::Unreachable))?;
    let handshake = timeout(
        Duration::from_secs(5),
        TlsConnector::from(Arc::new(config)).connect(name, tcp),
    )
    .await;
    let leaf = seen.lock().expect("pin lock").clone();
    match (handshake, leaf) {
        (Ok(Ok(stream)), Some(der)) => Ok((stream, der)),
        (Ok(Err(_)), Some(der)) if pin.is_some_and(|p| p != fingerprint(&der)) => Err(Ok(der)),
        (Ok(Err(_)), Some(_)) => Err(Err(Problem::NotMoss)),
        _ => Err(Err(Problem::Unreachable)),
    }
}

/// One HTTPS request over the pinned connection. Used by the notifier, which has no web view.
/// `Origin` is the server's own origin, as the server requires for writes.
pub async fn request(
    origin: &str,
    pin: &str,
    method: &str,
    path: &str,
    bearer: &str,
    body: Option<&str>,
) -> Result<(u16, Vec<u8>), Problem> {
    let (mut tls, _) = match open(origin, Some(pin)).await {
        Ok(ok) => ok,
        Err(Ok(der)) => {
            return Err(Problem::CertificateChanged {
                fingerprint: fingerprint(&der),
            })
        }
        Err(Err(problem)) => return Err(problem),
    };
    let authority = origin.trim_start_matches("https://");
    let payload = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nOrigin: {origin}\r\nAuthorization: Bearer {bearer}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let mut reply = Vec::new();
    let exchange = async {
        tls.write_all(request.as_bytes()).await?;
        (&mut tls).take(1024 * 1024).read_to_end(&mut reply).await
    };
    if !matches!(timeout(Duration::from_secs(10), exchange).await, Ok(Ok(_))) && reply.is_empty() {
        return Err(Problem::Unreachable);
    }
    let (status, body) = split_reply(&reply).ok_or(Problem::NotMoss)?;
    Ok((status, body.to_vec()))
}

/// Reads the certificate without trusting it, so the user can compare its code. No request is
/// sent over the connection.
pub async fn peek_certificate(origin: &str) -> Result<String, Problem> {
    match open(origin, None).await {
        Ok((_, der)) => Ok(fingerprint(&der)),
        Err(Ok(_)) => Err(Problem::NotMoss),
        Err(Err(problem)) => Err(problem),
    }
}

/// Connects with the pin, asks for hello and checks versions. Returns the leaf certificate so
/// the window's web engine can trust exactly the same one.
pub async fn hello(origin: &str, pin: &str) -> Result<(Hello, Vec<u8>), Problem> {
    let (mut tls, der) = match open(origin, Some(pin)).await {
        Ok(ok) => ok,
        Err(Ok(der)) => {
            return Err(Problem::CertificateChanged {
                fingerprint: fingerprint(&der),
            })
        }
        Err(Err(problem)) => return Err(problem),
    };
    let authority = origin.trim_start_matches("https://");
    let request = format!(
        "GET /api/hello HTTP/1.1\r\nHost: {authority}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    let mut reply = Vec::new();
    let exchange = async {
        tls.write_all(request.as_bytes()).await?;
        (&mut tls).take(64 * 1024).read_to_end(&mut reply).await
    };
    if !matches!(timeout(Duration::from_secs(10), exchange).await, Ok(Ok(_))) && reply.is_empty() {
        return Err(Problem::Unreachable);
    }
    let (status, body) = split_reply(&reply).ok_or(Problem::NotMoss)?;
    let hello = match status {
        200 => serde_json::from_slice::<Hello>(body).map_err(|_| Problem::NotMoss)?,
        421 => return Err(Problem::HostRefused),
        403 if body_code(body).as_deref() == Some("origin_or_sharing_refused") => {
            return Err(Problem::SharingOff)
        }
        _ => return Err(Problem::NotMoss),
    };
    if hello.product != "moss" {
        return Err(Problem::NotMoss);
    }
    compatible(hello.api)?;
    Ok((hello, der))
}

pub fn compatible(server: ApiRange) -> Result<(), Problem> {
    if SUPPORTED.overlaps(server) {
        Ok(())
    } else if server.current < SUPPORTED.oldest {
        Err(Problem::ServerTooOld)
    } else {
        Err(Problem::AppTooOld)
    }
}

fn split_reply(reply: &[u8]) -> Option<(u16, &[u8])> {
    let end = reply.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&reply[..end]).ok()?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    if head
        .lines()
        .any(|l| l.to_ascii_lowercase().starts_with("transfer-encoding:"))
    {
        return None;
    }
    Some((status, &reply[end + 4..]))
}

fn body_code(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()?
        .get("code")?
        .as_str()
        .map(str::to_owned)
}

fn owned(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| crate::store::mine(&m))
}

/// Another user who can write to the instance folder or its parent could point the app at their
/// own server, or have it start one.
fn trusted_folder(folder: &Path) -> bool {
    owned(folder.parent().unwrap_or(folder)) && owned(folder)
}

/// The local server for an instance folder, if its running file is trustworthy and current.
pub async fn local(folder: &Path) -> Result<(Running, Vec<u8>), Problem> {
    if !folder.join(NETWORK_FILE).is_file() {
        return Err(Problem::NotSetUp);
    }
    if !trusted_folder(folder) || !owned(&folder.join(RUNNING_FILE)) {
        return Err(Problem::Unreachable);
    }
    let running = Running::read(folder).map_err(|_| Problem::Unreachable)?;
    if !is_loopback_origin(&running.origin) || !alive(running.pid) {
        return Err(Problem::Unreachable);
    }
    match hello(&running.origin, &running.fingerprint).await {
        Ok((_, der)) => Ok((running, der)),
        // A stale file whose port now belongs to something else.
        Err(Problem::CertificateChanged { .. }) => Err(Problem::Unreachable),
        Err(problem) => Err(problem),
    }
}

#[cfg(target_os = "linux")]
fn alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn GetExitCodeProcess(process: isize, code: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const QUERY_LIMITED: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: plain handle calls; the handle is closed before return.
    unsafe {
        let handle = OpenProcess(QUERY_LIMITED, 0, pid);
        if handle == 0 {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn alive(_pid: u32) -> bool {
    true
}

/// Servers this app started, by instance folder, kept until they exit so they are reaped and a
/// retry waits for one that is still starting instead of starting another.
static STARTED: std::sync::Mutex<Vec<(PathBuf, Child)>> = std::sync::Mutex::new(Vec::new());

#[cfg(all(test, target_os = "linux"))]
pub(crate) fn stop_test_children(root: &Path) {
    let mut started = STARTED.lock().unwrap_or_else(|e| e.into_inner());
    started.retain_mut(|(folder, child)| {
        if folder.starts_with(root) {
            let _ = child.kill();
            let _ = child.wait();
            false
        } else {
            true
        }
    });
}

/// Whether a server this app started for the folder is still running. Reaps those that exited.
fn still_running(folder: &Path) -> bool {
    let mut started = STARTED.lock().unwrap_or_else(|e| e.into_inner());
    started.retain_mut(|(_, child)| matches!(child.try_wait(), Ok(None)));
    started.iter().any(|(f, _)| f == folder)
}

/// Starts the instance's server in its own process group, so it keeps running after the app.
fn start_local(install: &Path, folder: &Path) -> Result<(), Problem> {
    if still_running(folder) {
        return Ok(());
    }
    let log = {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(folder.join("server.log"))
            .map_err(|_| Problem::DidNotStart)?
    };
    let mut command = crate::launch::command(install, "moss-shell");
    command
        .arg("serve")
        .arg("--instance")
        .arg(folder)
        .arg("--web")
        .arg(install.join("web"))
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|_| Problem::DidNotStart)?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Detached, its own group, and no console window, so it outlives the app quietly.
        command.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    let child = command.spawn().map_err(|_| Problem::DidNotStart)?;
    STARTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push((folder.to_owned(), child));
    Ok(())
}

/// Holds the instance's start lock, so two apps on this computer never start it together.
/// None means another app holds it and is starting the server now.
fn start_lock(folder: &Path) -> Result<Option<std::fs::File>, Problem> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(folder.join("start.lock"))
        .map_err(|_| Problem::DidNotStart)?;
    portability::file_lock::try_exclusive(&file)
        .map(|acquired| acquired.then_some(file))
        .map_err(|_| Problem::DidNotStart)
}

/// Finds the local server, starting it if no one else is. The lock is released on return.
pub async fn local_or_start(install: &Path, folder: &Path) -> Result<(Running, Vec<u8>), Problem> {
    match local(folder).await {
        Err(Problem::Unreachable) => {}
        other => return other,
    }
    if !trusted_folder(folder) {
        return Err(Problem::Unreachable);
    }
    let lock = start_lock(folder)?;
    if lock.is_some() {
        match local(folder).await {
            Err(Problem::Unreachable) => {
                // An instance the app made has its own database, which must be up first.
                let (i, f) = (install.to_owned(), folder.to_owned());
                tokio::task::spawn_blocking(move || {
                    crate::provision::ensure_database(&i, &f, false)
                })
                .await
                .map_err(|_| Problem::DidNotStart)?
                .map_err(|_| Problem::DidNotStart)?;
                start_local(install, folder)?
            }
            other => return other,
        }
    }
    for _ in 0..80 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Ok(found) = local(folder).await {
            return Ok(found);
        }
        let gave_up = match &lock {
            // The server this app started has stopped, so waiting longer cannot help.
            Some(_) => !still_running(folder),
            // The app that was starting it has let go of the lock.
            None => start_lock(folder)?.is_some(),
        };
        if gave_up {
            // The other app may have let go just after its server came up.
            return local(folder).await.map_err(|_| Problem::DidNotStart);
        }
    }
    Err(Problem::DidNotStart)
}

/// Stops the running local server for an instance, then its database. Asks the server to finish
/// (it removes its running file on a clean stop) and gives up after thirty seconds.
#[cfg_attr(not(unix), allow(unused_variables))]
pub async fn stop_local(install: &Path, folder: &Path) -> Result<(), Problem> {
    // Wait for an in-progress connect/start, then hold the same lock through shutdown.
    // Dropping a UI result cannot cancel spawn_blocking database startup; this lock can.
    let _lock = timeout(Duration::from_secs(200), async {
        loop {
            if let Some(lock) = start_lock(folder)? {
                return Ok::<_, Problem>(lock);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| Problem::Unreachable)??;
    // Unreachable is not proof of death: leave the database alone if hello cannot answer.
    let (running, _) = local(folder).await?;
    if running.pid == 0 || running.pid > i32::MAX as u32 {
        return Err(Problem::Unreachable);
    }
    request_stop(folder, running.pid)?;
    for _ in 0..120 {
        still_running(folder);
        if !folder.join(RUNNING_FILE).exists() {
            let (i, f) = (install.to_owned(), folder.to_owned());
            // Where there is no database program yet (Windows) this finds nothing to stop.
            return tokio::task::spawn_blocking(move || crate::provision::stop_database(&i, &f))
                .await
                .map_err(|_| Problem::Unreachable)?
                .map_err(|_| Problem::Unreachable);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(Problem::Unreachable)
}

/// Asks the server whose certificate just answered for this folder to shut down.
#[cfg(unix)]
fn request_stop(_folder: &Path, pid: u32) -> Result<(), Problem> {
    // SAFETY: plain signal to a process whose certificate answered for this folder just now.
    if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
        return Err(Problem::Unreachable);
    }
    Ok(())
}

/// Windows has no termination signal for a background program, so the request is a file in the
/// server's private folder that names the server's process id.
#[cfg(not(unix))]
fn request_stop(folder: &Path, pid: u32) -> Result<(), Problem> {
    request_stop_by_file(folder, pid)
}

/// The file route. Kept compiled on every platform so Linux tests exercise what Windows runs.
#[cfg_attr(unix, allow(dead_code))]
pub(crate) fn request_stop_by_file(folder: &Path, pid: u32) -> Result<(), Problem> {
    moss_network::config::private_write(
        &folder.join(moss_network::tls::STOP_FILE),
        pid.to_string().as_bytes(),
    )
    .map_err(|_| Problem::Unreachable)
}

#[cfg(test)]
mod tests;
