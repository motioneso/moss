//! Mail login test. It signs in to the IMAP server and then to the SMTP server and says
//! which way it failed. It talks to the address in the config and nowhere else. The password
//! is passed to the two protocol libraries and never written to a log or an error.
use async_imap::Client;
use lettre::{
    transport::smtp::{
        authentication::Credentials,
        client::{Certificate, CertificateStore, Tls, TlsParameters},
    },
    AsyncSmtpTransport, Tokio1Executor,
};
use std::{error::Error as StdError, fmt::Debug, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{CertificateDer, ServerName},
        ClientConfig, RootCertStore,
    },
    TlsConnector,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    AuthFailed,
    TlsFailed,
    Unreachable,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::AuthFailed => "auth_failed",
            Outcome::TlsFailed => "tls_failed",
            Outcome::Unreachable => "unreachable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Smtp {
    ImplicitTls,
    Starttls,
    None,
}

/// The servers to sign in to. Built from a provider preset, never from the request.
#[derive(Debug, Clone)]
pub struct Servers {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_tls: bool,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: Smtp,
}

/// Which certificates the probe trusts. Production trusts the bundled public roots.
/// Tests trust only the certificates they list.
#[derive(Debug, Clone, Default)]
pub struct Trust {
    pub only: Option<Vec<Vec<u8>>>,
}

const LIMIT: Duration = Duration::from_secs(15);

pub async fn probe(servers: &Servers, trust: &Trust, username: &str, password: &str) -> Outcome {
    match tokio::time::timeout(LIMIT, async {
        match imap(servers, trust, username, password).await {
            Outcome::Ok => smtp(servers, trust, username, password).await,
            failed => failed,
        }
    })
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => Outcome::Unreachable,
    }
}

pub(crate) fn client_config(trust: &Trust) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    match &trust.only {
        None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
        Some(list) => {
            for der in list {
                let _ = roots.add(CertificateDer::from(der.clone()));
            }
        }
    }
    Arc::new(
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// A handshake refusal carries a TLS error inside the I/O error.
pub(crate) fn is_tls_error(error: &(dyn StdError + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(e) = current {
        if e.downcast_ref::<rustls::Error>().is_some() {
            return true;
        }
        // An I/O error hides the error it wraps from `source`, so look inside it.
        if let Some(inner) = e.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            if is_tls_error(inner) {
                return true;
            }
        }
        current = e.source();
    }
    false
}

async fn imap(servers: &Servers, trust: &Trust, username: &str, password: &str) -> Outcome {
    let Ok(tcp) = TcpStream::connect((servers.imap_host.as_str(), servers.imap_port)).await else {
        return Outcome::Unreachable;
    };
    let connector = TlsConnector::from(client_config(trust));
    let Ok(name) = ServerName::try_from(servers.imap_host.clone()) else {
        return Outcome::Unreachable;
    };
    if servers.imap_tls {
        return match connector.connect(name, tcp).await {
            Ok(stream) => sign_in(Client::new(stream), false, username, password).await,
            Err(e) if is_tls_error(&e) => Outcome::TlsFailed,
            Err(_) => Outcome::Unreachable,
        };
    }
    // The old server asked for STARTTLS and carried on in plain text when it was refused.
    let mut client = Client::new(tcp);
    if client.read_response().await.ok().flatten().is_none() {
        return Outcome::Unreachable;
    }
    match client.run_command_and_check_ok("STARTTLS", None).await {
        Ok(()) => match connector.connect(name, client.into_inner()).await {
            Ok(stream) => sign_in(Client::new(stream), true, username, password).await,
            Err(e) if is_tls_error(&e) => Outcome::TlsFailed,
            Err(_) => Outcome::Unreachable,
        },
        Err(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_)) => {
            sign_in(client, true, username, password).await
        }
        Err(_) => Outcome::Unreachable,
    }
}

/// `greeted` says the server greeting has already been read.
async fn sign_in<T>(mut client: Client<T>, greeted: bool, username: &str, password: &str) -> Outcome
where
    T: AsyncRead + AsyncWrite + Unpin + Debug + Send,
{
    if !greeted && client.read_response().await.ok().flatten().is_none() {
        return Outcome::Unreachable;
    }
    match client.login(username, password).await {
        Ok(mut session) => {
            let _ = session.logout().await;
            Outcome::Ok
        }
        // The old server counted every refused LOGIN, including a connection limit, as a bad password.
        Err((async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_), _)) => {
            Outcome::AuthFailed
        }
        Err((async_imap::error::Error::Validate(_), _)) => Outcome::AuthFailed,
        Err(_) => Outcome::Unreachable,
    }
}

async fn smtp(servers: &Servers, trust: &Trust, username: &str, password: &str) -> Outcome {
    let mut params = TlsParameters::builder(servers.smtp_host.clone());
    match &trust.only {
        None => params = params.certificate_store(CertificateStore::WebpkiRoots),
        Some(list) => {
            params = params.certificate_store(CertificateStore::None);
            for der in list {
                if let Ok(cert) = Certificate::from_der(der.clone()) {
                    params = params.add_root_certificate(cert);
                }
            }
        }
    }
    let Ok(params) = params.build_rustls() else {
        return Outcome::Unreachable;
    };
    let tls = match servers.smtp_security {
        Smtp::ImplicitTls => Tls::Wrapper(params),
        Smtp::Starttls => Tls::Required(params),
        Smtp::None => Tls::Opportunistic(params),
    };
    let transport = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&servers.smtp_host)
        .port(servers.smtp_port)
        .tls(tls)
        .credentials(Credentials::new(username.to_string(), password.to_string()))
        .timeout(Some(LIMIT))
        .build::<Tokio1Executor>();
    match transport.test_connection().await {
        Ok(_) => Outcome::Ok,
        Err(e) if is_tls_error(&e) || e.is_tls() => Outcome::TlsFailed,
        // 530, 534, 535 and 538 are the refusals of a login.
        Err(e) if e.status().is_some_and(|code| matches!(u16::from(code), 530 | 534 | 535 | 538)) => {
            Outcome::AuthFailed
        }
        Err(_) => Outcome::Unreachable,
    }
}
