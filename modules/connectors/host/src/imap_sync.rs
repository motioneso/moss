//! IMAP mail sync in the host. The package asks for a listing of the inbox, a batch of
//! parsed messages and the sync record. This file owns the network, the password and the
//! mail parser. Answers carry message metadata and a short preview, never the password.
use crate::imap::MailConfig;
use crate::mail_probe::{client_config, is_tls_error, Servers, Trust};
use crate::store;
use anyhow::{anyhow, bail, Result};
use async_imap::{Client, Session};
use futures_util::TryStreamExt;
use mail_parser::{Addr, Address, MessageParser};
use moss_module_host::runtime::Request;
use portability::secrets::JsonSecretCipher;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use std::fmt::Debug;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_rustls::{rustls::pki_types::ServerName, TlsConnector};
use uuid::Uuid;

/// The folder the sync reads.
pub const FOLDER: &str = "INBOX";
/// A listing covers this many days of mail.
const WINDOW_DAYS: i64 = 30;
/// A listing never holds more than the newest messages up to this count.
const LIST_CAP: usize = 5000;
/// A message is read only up to this many bytes. The preview needs far less.
const FETCH_BYTES: usize = 128 * 1024;
const PREVIEW_CHARS: usize = 500;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Debug> Io for T {}
type Stream = Box<dyn Io>;

enum Fail {
    Auth,
    Tls,
    Unreachable,
}

impl Fail {
    fn answer(&self) -> Value {
        let result = match self {
            Fail::Auth => "auth_failed",
            Fail::Tls => "tls_failed",
            Fail::Unreachable => "unreachable",
        };
        json!({"result":result})
    }
}

pub async fn run(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &MailConfig,
    request: &Request,
) -> Result<Value> {
    let p = &request.parameters;
    let id = Uuid::parse_str(store::text(p, "accountId")?).map_err(|_| anyhow!("Invalid account"))?;
    match request.resource.as_str() {
        "connectors.imap-sync-start" => start(cx, id).await,
        "connectors.imap-sync-finish" => finish(cx, id, p).await,
        "connectors.imap-list" => {
            let Some(login) = login(cx, cipher, config, id).await? else {
                return Ok(json!({"result":"inactive"}));
            };
            Ok(list(&login).await.unwrap_or_else(|e| e.answer()))
        }
        "connectors.imap-fetch" => {
            let Some(login) = login(cx, cipher, config, id).await? else {
                return Ok(json!({"result":"inactive"}));
            };
            let uids: Vec<u32> = p["uids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|u| u.as_u64().and_then(|u| u32::try_from(u).ok()))
                .collect();
            let validity = p["uidValidity"].as_u64().unwrap_or(0);
            Ok(fetch(&login, &uids, validity).await.unwrap_or_else(|e| e.answer()))
        }
        _ => bail!("Unknown connectors resource"),
    }
}

/// Marks a run as started and keeps the finished run before it. A run already going, and
/// an account that is revoked or not mail, start nothing.
async fn start(cx: &DataContext, id: Uuid) -> Result<Value> {
    let started = cx
        .db()
        .execute(
            "UPDATE app.connector_accounts SET
               previous_sync = CASE WHEN last_sync_status IS NOT NULL THEN jsonb_build_object(
                   'startedAt', last_sync_started_at, 'finishedAt', last_sync_finished_at,
                   'status', last_sync_status, 'errorCode', last_sync_error,
                   'counts', last_sync_counts, 'trigger', last_sync_trigger)
                 ELSE previous_sync END,
               last_sync_started_at = now(), last_sync_finished_at = NULL,
               last_sync_status = NULL, last_sync_error = NULL, last_sync_counts = NULL,
               last_sync_trigger = 'schedule'
             WHERE id = $1 AND status <> 'revoked' AND provider_id LIKE 'imap-%'
               AND (last_sync_status IS NOT NULL OR last_sync_started_at IS NULL
                    OR last_sync_started_at < now() - interval '840 seconds')",
            &[&id],
        )
        .await?;
    if started == 1 {
        return Ok(json!({"state":"started"}));
    }
    let live = cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.connector_accounts
              WHERE id = $1 AND status <> 'revoked' AND provider_id LIKE 'imap-%'",
            &[&id],
        )
        .await?;
    Ok(json!({"state": if live.is_some() { "busy" } else { "inactive" }}))
}

async fn finish(cx: &DataContext, id: Uuid, p: &Value) -> Result<Value> {
    let status = store::text(p, "status")?;
    if !["success", "partial", "failed"].contains(&status) {
        bail!("Invalid sync status");
    }
    let error = p["error"].as_str().filter(|e| ["auth-error", "email-error", "email-message-error"].contains(e));
    let counts = json!({
        "emailUpserted":p["counts"]["emailUpserted"].as_i64().unwrap_or(0),
        "emailFailures":p["counts"]["emailFailures"].as_i64().unwrap_or(0),
        "truncated":p["counts"]["truncated"].as_bool().unwrap_or(false),
    });
    cx.db()
        .execute(
            "UPDATE app.connector_accounts SET last_sync_finished_at = now(), last_sync_status = $2,
               last_sync_error = $3, last_sync_counts = $4
             WHERE id = $1 AND status <> 'revoked'",
            &[&id, &status, &error, &counts],
        )
        .await?;
    Ok(json!({"saved":true}))
}

struct Login {
    servers: Servers,
    trust: Trust,
    username: String,
    password: String,
}

/// The person's mail login, or None when the account is revoked, gone or not a mail account.
async fn login(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &MailConfig,
    id: Uuid,
) -> Result<Option<Login>> {
    let row = cx
        .db()
        .query_opt(
            "SELECT provider_id, encrypted_secret FROM app.connector_accounts
              WHERE id = $1 AND status <> 'revoked' AND provider_id LIKE 'imap-%'",
            &[&id],
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    let provider: String = row.get(0);
    let envelope: Option<Value> = row.get(1);
    let (Some(envelope), Some((servers, trust))) = (envelope, config.servers(&provider)) else {
        return Ok(None);
    };
    let bundle = cipher
        .parse_envelope(&envelope)
        .and_then(|parsed| cipher.decrypt_json(&parsed))
        .map_err(|_| anyhow!("The stored mail sign-in cannot be read"))?
        .value;
    let text = |name: &str| bundle.get(name).and_then(Value::as_str).map(String::from);
    let (Some(username), Some(password)) = (text("username"), text("password")) else {
        return Ok(None);
    };
    Ok(Some(Login { servers, trust, username, password }))
}

async fn open(login: &Login) -> std::result::Result<Session<Stream>, Fail> {
    let servers = &login.servers;
    let tcp = TcpStream::connect((servers.imap_host.as_str(), servers.imap_port))
        .await
        .map_err(|_| Fail::Unreachable)?;
    let connector = TlsConnector::from(client_config(&login.trust));
    let name = ServerName::try_from(servers.imap_host.clone()).map_err(|_| Fail::Unreachable)?;
    let handshake = |e: std::io::Error| if is_tls_error(&e) { Fail::Tls } else { Fail::Unreachable };
    let client = if servers.imap_tls {
        let tls = connector.connect(name, tcp).await.map_err(handshake)?;
        let mut client = Client::new(Box::new(tls) as Stream);
        client.read_response().await.ok().flatten().ok_or(Fail::Unreachable)?;
        client
    } else {
        let mut client = Client::new(Box::new(tcp) as Stream);
        client.read_response().await.ok().flatten().ok_or(Fail::Unreachable)?;
        match client.run_command_and_check_ok("STARTTLS", None).await {
            Ok(()) => {
                let tls = connector.connect(name, client.into_inner()).await.map_err(handshake)?;
                Client::new(Box::new(tls) as Stream)
            }
            // A server without STARTTLS keeps talking in plain text, as the old sync did.
            Err(async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_)) => client,
            Err(_) => return Err(Fail::Unreachable),
        }
    };
    client.login(&login.username, &login.password).await.map_err(|(e, _)| match e {
        async_imap::error::Error::No(_)
        | async_imap::error::Error::Bad(_)
        | async_imap::error::Error::Validate(_) => Fail::Auth,
        _ => Fail::Unreachable,
    })
}

fn unreachable(_: impl Debug) -> Fail {
    Fail::Unreachable
}

/// UIDs as a compact IMAP set such as `3:9,12`.
fn uid_set(uids: &[u32]) -> String {
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    let mut parts: Vec<String> = vec![];
    let mut i = 0;
    while i < sorted.len() {
        let mut j = i;
        while j + 1 < sorted.len() && sorted[j + 1] == sorted[j] + 1 {
            j += 1;
        }
        parts.push(if j > i { format!("{}:{}", sorted[i], sorted[j]) } else { sorted[i].to_string() });
        i = j + 1;
    }
    parts.join(",")
}

fn since_day() -> String {
    (chrono::Utc::now() - chrono::Duration::days(WINDOW_DAYS)).format("%d-%b-%Y").to_string()
}

async fn list(login: &Login) -> std::result::Result<Value, Fail> {
    let mut session = open(login).await?;
    let result = async {
        let mailbox = session.examine(FOLDER).await.map_err(unreachable)?;
        let validity = mailbox.uid_validity.unwrap_or(0);
        let mut uids: Vec<u32> =
            session.uid_search(format!("SINCE {}", since_day())).await.map_err(unreachable)?.into_iter().collect();
        uids.sort_unstable();
        let truncated = uids.len() > LIST_CAP;
        if truncated {
            uids = uids.split_off(uids.len() - LIST_CAP);
        }
        let mut keys = vec![];
        if !uids.is_empty() {
            let stream = session.uid_fetch(uid_set(&uids), "(UID RFC822.SIZE)").await.map_err(unreachable)?;
            let fetched: Vec<_> = stream.try_collect().await.map_err(unreachable)?;
            for f in &fetched {
                if let Some(uid) = f.uid {
                    keys.push((uid, f.size.unwrap_or(0)));
                }
            }
            keys.sort_unstable();
        }
        Ok(json!({
            "uidValidity":validity,"truncated":truncated,"since":since_iso(),
            "keys":keys.iter().map(|(uid, size)| json!({"uid":uid,"size":size})).collect::<Vec<_>>(),
        }))
    }
    .await;
    let _ = session.logout().await;
    result
}

fn since_iso() -> String {
    (chrono::Utc::now() - chrono::Duration::days(WINDOW_DAYS)).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

async fn fetch(login: &Login, uids: &[u32], validity: u64) -> std::result::Result<Value, Fail> {
    if uids.is_empty() {
        return Ok(json!({"messages":[],"failed":[]}));
    }
    let mut session = open(login).await?;
    let result = async {
        let mailbox = session.examine(FOLDER).await.map_err(unreachable)?;
        if u64::from(mailbox.uid_validity.unwrap_or(0)) != validity {
            return Ok(json!({"result":"changed"}));
        }
        let query = format!("(UID RFC822.SIZE INTERNALDATE BODY.PEEK[]<0.{FETCH_BYTES}>)");
        let stream = session.uid_fetch(uid_set(uids), query).await.map_err(unreachable)?;
        let fetched: Vec<_> = stream.try_collect().await.map_err(unreachable)?;
        let (mut messages, mut seen) = (vec![], vec![]);
        for f in &fetched {
            let Some(uid) = f.uid else { continue };
            seen.push(uid);
            let received = f.internal_date().map(|d| d.to_rfc3339());
            if let Some(raw) = f.body() {
                messages.push(parse(uid, f.size.unwrap_or(0), received.as_deref(), raw));
            }
        }
        let parsed: Vec<u32> = messages.iter().filter_map(|m| m["uid"].as_u64().map(|u| u as u32)).collect();
        let failed: Vec<u32> = uids.iter().copied().filter(|u| !parsed.contains(u)).collect();
        Ok(json!({"messages":messages,"failed":failed}))
    }
    .await;
    let _ = session.logout().await;
    result
}

fn addr_text(addr: &Addr) -> Option<String> {
    let address = addr.address()?.trim().to_string();
    if address.is_empty() {
        return None;
    }
    Some(match addr.name() {
        Some(name) if !name.trim().is_empty() => format!("{} <{}>", name.trim(), address),
        _ => address,
    })
}

fn addresses(list: Option<&Address>) -> Vec<String> {
    list.map(|a| a.iter().filter_map(|a| a.address().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

/// Sign-in code wording in the subject plus a short code in the subject or the opening of
/// the text. This is cruder than the old three-signal rule and errs toward hiding a preview.
pub fn looks_like_one_time_code(subject: &str, text: &str) -> bool {
    const PHRASES: [&str; 14] = [
        "verification code", "one-time code", "one time code", "one-time passcode", "one-time password",
        "single-use code", "login code", "log-in code", "sign-in code", "sign in code", "authentication code",
        "security code", "two-factor code", "2fa code",
    ];
    let subject = subject.to_lowercase();
    if !PHRASES.iter().any(|p| subject.contains(p)) {
        return false;
    }
    let opening: String = text.chars().take(400).collect();
    let code = |s: &str| {
        s.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| (4..=8).contains(&w.len()) && w.chars().any(|c| c.is_ascii_digit()))
    };
    code(&subject) || code(&opening)
}

/// One parsed message as the package stores it. The preview is plain text with white space
/// collapsed, cut to a fixed length, and absent for a sign-in code message.
pub fn parse(uid: u32, size: u32, internal_date: Option<&str>, raw: &[u8]) -> Value {
    let Some(message) = MessageParser::default().parse(raw) else {
        return json!({"uid":uid,"unreadable":true});
    };
    let subject = message.subject().map(str::to_string).filter(|s| !s.is_empty()).unwrap_or_else(|| "(no subject)".into());
    let from = message.from().and_then(|a| a.first()).and_then(addr_text).unwrap_or_else(|| "(unknown)".into());
    let recipients: Vec<String> = addresses(message.to()).into_iter().chain(addresses(message.cc())).collect();
    let received = message
        .date()
        .map(|d| d.to_rfc3339())
        .or_else(|| internal_date.map(String::from))
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let text = message.body_text(0).map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let preview: String = text.chars().take(PREVIEW_CHARS).collect();
    let hidden = looks_like_one_time_code(&subject, &text);
    let references: Vec<String> = message.references().as_text_list().unwrap_or_default().iter().map(|r| r.to_string()).collect();
    json!({
        "uid":uid,"sizeBytes":size,"sender":from,"recipients":recipients,"subject":subject,
        "receivedAt":received,
        "snippet": if hidden || preview.is_empty() { Value::Null } else { json!(preview) },
        "messageId":message.message_id(),"references":references,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_is_compact() {
        assert_eq!(uid_set(&[9, 3, 4, 5, 12]), "3:5,9,12");
        assert_eq!(uid_set(&[7]), "7");
    }

    #[test]
    fn parses_headers_and_preview() {
        let raw = b"From: Ann Lee <ann@example.test>\r\nTo: bob@example.test\r\nCc: cy@example.test\r\nSubject: Hello\r\nDate: Mon, 02 Mar 2026 09:15:00 +0000\r\nMessage-ID: <a@x>\r\nReferences: <r1@x> <r2@x>\r\n\r\nHi   there\r\n  friend.\r\n";
        let m = parse(7, 100, None, raw);
        assert_eq!(m["sender"], "Ann Lee <ann@example.test>");
        assert_eq!(m["recipients"], json!(["bob@example.test", "cy@example.test"]));
        assert_eq!(m["snippet"], "Hi there friend.");
        assert_eq!(m["references"], json!(["r1@x", "r2@x"]));
        assert_eq!(m["messageId"], "a@x");
    }

    #[test]
    fn sign_in_code_hides_preview() {
        let raw = b"From: a@x.test\r\nSubject: Your verification code\r\n\r\nYour code is 482913. Do not share it.\r\n";
        assert!(parse(1, 10, None, raw)["snippet"].is_null());
        let plain = b"From: a@x.test\r\nSubject: Lunch\r\n\r\nYour code is 482913.\r\n";
        assert!(!parse(2, 10, None, plain)["snippet"].is_null());
    }
}
