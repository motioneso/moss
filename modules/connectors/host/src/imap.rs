//! IMAP mail connect in the host. It owns the provider presets, tests the login against
//! the mail servers and seals the password. The server settings come from the preset, never
//! from the request, and no answer to the package carries the password.
use crate::mail_probe::{probe, Servers, Smtp, Trust};
use crate::store;
use anyhow::{anyhow, bail, ensure, Result};
use moss_module_host::runtime::Request;
use portability::secrets::JsonSecretCipher;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use std::net::IpAddr;
use uuid::Uuid;

fn preset(provider: &str) -> Option<Servers> {
    let (imap, imap_tls, smtp, smtp_port, security) = match provider {
        "imap-yahoo" => ("imap.mail.yahoo.com:993", true, "smtp.mail.yahoo.com", 465, Smtp::ImplicitTls),
        "imap-proton" => ("127.0.0.1:1143", false, "127.0.0.1", 1025, Smtp::None),
        "imap-icloud" => ("imap.mail.me.com:993", true, "smtp.mail.me.com", 587, Smtp::Starttls),
        "imap-fastmail" => ("imap.fastmail.com:993", true, "smtp.fastmail.com", 465, Smtp::ImplicitTls),
        _ => return None,
    };
    let (host, port) = imap.split_once(':')?;
    Some(Servers {
        imap_host: host.into(),
        imap_port: port.parse().ok()?,
        imap_tls,
        smtp_host: smtp.into(),
        smtp_port,
        smtp_security: security,
    })
}

fn security_name(security: Smtp) -> &'static str {
    match security {
        Smtp::ImplicitTls => "implicit_tls",
        Smtp::Starttls => "starttls",
        Smtp::None => "none",
    }
}

/// Where the login test goes. Production uses each provider's own servers and the bundled
/// public certificates. A test-only setting points every provider at a stand-in on this
/// machine and trusts only the certificates it lists.
pub struct MailConfig {
    stand_in: Option<(Servers, Trust)>,
}

impl MailConfig {
    pub fn production() -> Self {
        Self { stand_in: None }
    }

    /// Both servers on this machine. This exists only for tests and the test-only setting, and
    /// it refuses any address that is not loopback. `trusted` is the DER of each certificate
    /// the stand-in may present, and an empty list trusts nothing.
    pub fn test_only_loopback(servers: Servers, trusted: Vec<Vec<u8>>) -> Result<Self> {
        for host in [&servers.imap_host, &servers.smtp_host] {
            let loopback = host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
            ensure!(loopback, "The test-only mail servers must be on this machine");
        }
        Ok(Self { stand_in: Some((servers, Trust { only: Some(trusted) })) })
    }

    fn servers(&self, provider: &str) -> Option<(Servers, Trust)> {
        match &self.stand_in {
            Some(found) => Some(found.clone()),
            None => preset(provider).map(|s| (s, Trust::default())),
        }
    }
}

pub async fn run(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &MailConfig,
    request: &Request,
) -> Result<Value> {
    let p = &request.parameters;
    let (provider, username, password) = (
        store::text(p, "providerId")?,
        store::text(p, "username")?,
        store::text(p, "password")?,
    );
    let Some((servers, trust)) = config.servers(provider) else {
        bail!("Unknown imap provider");
    };
    let outcome = probe(&servers, &trust, username, password).await;
    match (request.resource.as_str(), outcome.as_str()) {
        ("connectors.imap-test", result) => Ok(json!({"result":result})),
        ("connectors.imap-connect", "ok") => {
            // The sealed bundle holds the preset servers, as the old server wrote it.
            let real = preset(provider).ok_or_else(|| anyhow!("Unknown imap provider"))?;
            let bundle = json!({
                "kind":"imap-password","providerId":provider,"username":username,"password":password,
                "imapHost":real.imap_host,"imapPort":real.imap_port,"imapTls":real.imap_tls,
                "smtpHost":real.smtp_host,"smtpPort":real.smtp_port,
                "smtpSecurity":security_name(real.smtp_security),
            });
            Ok(json!({"account":upsert(cx, cipher, provider, bundle).await?}))
        }
        ("connectors.imap-connect", result) => Ok(json!({"result":result})),
        _ => bail!("Unknown connectors resource"),
    }
}

/// Updates the person's account for this provider or creates it, with the provider's default scopes.
async fn upsert(cx: &DataContext, cipher: &JsonSecretCipher, provider: &str, bundle: Value) -> Result<Value> {
    let scopes: Vec<String> = cx
        .db()
        .query_opt("SELECT default_scopes FROM app.connector_definitions WHERE provider_id = $1", &[&provider])
        .await?
        .map(|row| row.get(0))
        .unwrap_or_default();
    let existing = cx
        .db()
        .query_opt("SELECT id FROM app.connector_accounts WHERE provider_id = $1", &[&provider])
        .await?;
    match existing {
        Some(row) => {
            let id: Uuid = row.get(0);
            store::update(
                cx,
                cipher,
                &json!({"id":id.to_string(),"scopes":scopes,"status":"active","tokenPayload":bundle}),
            )
            .await
        }
        None => {
            store::create(
                cx,
                cipher,
                &json!({"providerId":provider,"scopes":scopes,"status":"active","tokenPayload":bundle}),
            )
            .await
        }
    }
}
