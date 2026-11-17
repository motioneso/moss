//! Test certificates and TLS configs for the IMAP and SMTP stand-ins.
//!
//! The keys are throwaway test keys with no authority anywhere. `SELF_SIGNED` is valid for
//! `localhost` and `127.0.0.1`. `WRONG_HOST` is valid only for `mail.example.com`.

use std::sync::Arc;
use tokio_rustls::rustls::{
    pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer},
    ClientConfig, RootCertStore, ServerConfig,
};

pub struct Identity {
    pub cert_pem: &'static str,
    pub key_pem: &'static str,
}

pub const SELF_SIGNED: Identity = Identity {
    cert_pem: include_str!("../fixtures/tls/self-signed.cert.pem"),
    key_pem: include_str!("../fixtures/tls/self-signed.key.pem"),
};

pub const WRONG_HOST: Identity = Identity {
    cert_pem: include_str!("../fixtures/tls/wrong-host.cert.pem"),
    key_pem: include_str!("../fixtures/tls/wrong-host.key.pem"),
};

fn provider() -> Arc<tokio_rustls::rustls::crypto::CryptoProvider> {
    Arc::new(tokio_rustls::rustls::crypto::ring::default_provider())
}

pub fn server_config(id: &Identity) -> Arc<ServerConfig> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(id.cert_pem.as_bytes())
        .collect::<Result<_, _>>()
        .expect("test certificate parses");
    let key = PrivateKeyDer::from_pem_slice(id.key_pem.as_bytes()).expect("test key parses");
    Arc::new(
        ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .expect("test certificate matches key"),
    )
}

/// A client that trusts exactly the given certificate.
pub fn client_trusting(id: &Identity) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(id.cert_pem.as_bytes()) {
        roots.add(cert.expect("test certificate parses")).expect("root accepted");
    }
    client_with(roots)
}

/// A client with an empty trust store, like a client that does not know the server.
pub fn client_trusting_nothing() -> Arc<ClientConfig> {
    client_with(RootCertStore::empty())
}

fn client_with(roots: RootCertStore) -> Arc<ClientConfig> {
    Arc::new(
        ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}
