//! Writes to the signed-in person's own mail and calendar: drafts, sends and calendar changes.
//! Every resource runs under the person's row-level security, so another person's account is
//! unreachable. A write is sent once and never retried, because a repeated send would send
//! twice. Answers carry a status and a cleaned reason only. Mail text, tokens and Google error
//! bodies never reach an answer or a log.
use crate::google::{self, GoogleConfig, RefreshFailure};
use crate::google_sync::{list_url, reason_of, urlencode, Failure};
use crate::imap::MailConfig;
use crate::imap_sync::{login, open};
use crate::mail_probe::{is_tls_error, smtp_transport};
use crate::store;
use anyhow::{anyhow, bail, Result};
use futures_util::TryStreamExt;
use lettre::{address::Envelope, AsyncTransport};
use moss_module_host::runtime::Request;
use portability::secrets::JsonSecretCipher;
use reqwest::Method;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// A write must finish inside the five seconds the host gives a package call.
const BUDGET: Duration = Duration::from_millis(4000);
const MIME_MAX: usize = 1_000_000;

pub async fn run(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    google: &GoogleConfig,
    mail: &MailConfig,
    request: &Request,
) -> Result<Value> {
    let p = &request.parameters;
    let id = Uuid::parse_str(store::text(p, "accountId")?).map_err(|_| anyhow!("Invalid account"))?;
    let deadline = Instant::now() + BUDGET;
    match request.resource.as_str() {
        "connectors.write-imap-send" | "connectors.write-imap-draft" => {
            imap(cx, cipher, mail, id, request, deadline).await
        }
        _ => {
            if !active_google(cx, id).await? {
                return Ok(json!({"result":"inactive"}));
            }
            let answer = match request.resource.as_str() {
                "connectors.write-gmail-draft" => gmail(cx, cipher, google, p, true, deadline).await?,
                "connectors.write-gmail-send" => gmail(cx, cipher, google, p, false, deadline).await?,
                "connectors.write-calendar-freebusy" => freebusy(cx, cipher, google, p, deadline).await?,
                "connectors.write-calendar-insert" => insert(cx, cipher, google, p, deadline).await?,
                "connectors.write-calendar-patch" => patch(cx, cipher, google, p, deadline).await?,
                "connectors.write-calendar-delete" => delete(cx, cipher, google, p, deadline).await?,
                _ => bail!("Unknown connectors resource"),
            };
            Ok(answer.unwrap_or_else(|failure| failure.answer()))
        }
    }
}

/// Row-level security keeps every other person's accounts out of this query.
async fn active_google(cx: &DataContext, id: Uuid) -> Result<bool> {
    Ok(cx
        .db()
        .query_opt(
            "SELECT 1 FROM app.connector_accounts WHERE id = $1 AND status = 'active' AND provider_id = 'google'",
            &[&id],
        )
        .await?
        .is_some())
}

struct Reply {
    status: u16,
    body: Value,
}

type Sent = std::result::Result<Reply, Failure>;
type Answer = std::result::Result<Value, Failure>;

/// One Google write, refreshed once on a 401 and never retried otherwise. Any HTTP answer comes
/// back as a reply, so the caller decides which statuses count.
async fn write(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    method: Method,
    url: url::Url,
    body: Option<Value>,
    operation: &'static str,
    deadline: Instant,
) -> Result<Sent> {
    let fail = |status, reason, sign_in| Err(Failure { status, reason, operation, sign_in });
    let mut token = match google::fresh_access_token(cx, cipher, config, false).await? {
        Ok(token) => token,
        Err(RefreshFailure::NeedsSignIn) => return Ok(fail(None, None, true)),
        Err(_) => return Ok(fail(None, None, false)),
    };
    let mut refreshed = false;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(fail(None, Some("timeout".into()), false));
        }
        let sent = config.request(method.clone(), url.clone(), &token, body.clone(), left);
        let Ok(Ok((status, raw))) = tokio::time::timeout(left, sent).await else {
            return Ok(fail(None, Some("timeout".into()), false));
        };
        if status == 401 && !refreshed {
            refreshed = true;
            match google::fresh_access_token(cx, cipher, config, true).await? {
                Ok(next) => {
                    token = next;
                    continue;
                }
                Err(RefreshFailure::NeedsSignIn) => return Ok(fail(Some(401), None, true)),
                Err(_) => return Ok(fail(Some(401), None, false)),
            }
        }
        if status == 401 {
            return Ok(fail(Some(401), reason_of(&raw), true));
        }
        if !(200..300).contains(&status) {
            let reason = reason_of(&raw);
            return Ok(Ok(Reply { status, body: json!({"reason":reason}) }));
        }
        return Ok(Ok(Reply { status, body: serde_json::from_slice(&raw).unwrap_or(Value::Null) }));
    }
}

/// A refused write as a failure answer that holds only the status and a cleaned reason.
fn refused(reply: &Reply, operation: &'static str) -> Failure {
    Failure {
        status: Some(reply.status),
        reason: reply.body["reason"].as_str().map(String::from),
        operation,
        sign_in: false,
    }
}

fn calendar_url(config: &GoogleConfig, calendar: &str, tail: &str) -> Result<url::Url> {
    list_url(config.calendar_base(), &format!("calendars/{}{tail}", urlencode(calendar)), &[])
}

fn calendar_id(p: &Value) -> &str {
    p["calendarId"].as_str().filter(|c| !c.is_empty()).unwrap_or("primary")
}

fn mime<'a>(p: &'a Value) -> Result<&'a str> {
    let text = store::text(p, "mime")?;
    if text.len() > MIME_MAX {
        bail!("The message is too large");
    }
    Ok(text)
}

async fn gmail(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    draft: bool,
    deadline: Instant,
) -> Result<Answer> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mime(p)?);
    let mut message = json!({"raw":raw});
    // Gmail only threads a reply when the thread id is sent with it.
    if let Some(thread) = p["threadId"].as_str().filter(|t| !t.is_empty()) {
        message["threadId"] = json!(thread);
    }
    let (tail, body, operation) = if draft {
        ("drafts", json!({"message":message}), "gmail-draft")
    } else {
        ("messages/send", message, "gmail-send")
    };
    let url = list_url(config.gmail_base(), &format!("users/me/{tail}"), &[])?;
    let sent = write(cx, cipher, config, Method::POST, url, Some(body), operation, deadline).await?;
    Ok(sent.and_then(|r| {
        if !(200..300).contains(&r.status) {
            return Err(refused(&r, operation));
        }
        let message = if draft { &r.body["message"] } else { &r.body };
        Ok(json!({"result":"ok","id":r.body["id"],"messageId":message["id"],"threadId":message["threadId"]}))
    }))
}

async fn freebusy(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    deadline: Instant,
) -> Result<Answer> {
    let calendar = calendar_id(p);
    let body = json!({
        "timeMin": store::text(p, "timeMin")?, "timeMax": store::text(p, "timeMax")?,
        "items": [{"id": calendar}],
    });
    let url = list_url(config.calendar_base(), "freeBusy", &[])?;
    let sent = write(cx, cipher, config, Method::POST, url, Some(body), "calendar-freebusy", deadline).await?;
    Ok(sent.and_then(|r| {
        if !(200..300).contains(&r.status) {
            return Err(refused(&r, "calendar-freebusy"));
        }
        let busy = r.body["calendars"][calendar]["busy"].clone();
        Ok(json!({"result":"ok","busy":if busy.is_array() { busy } else { json!([]) }}))
    }))
}

async fn insert(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    deadline: Instant,
) -> Result<Answer> {
    if !p["event"].is_object() {
        bail!("Missing event");
    }
    let url = calendar_url(config, calendar_id(p), "/events")?;
    let sent = write(cx, cipher, config, Method::POST, url, Some(p["event"].clone()), "calendar-insert", deadline).await?;
    Ok(sent.and_then(|r| match r.status {
        200..=299 => Ok(json!({"result":"ok","created":true,"eventId":r.body["id"]})),
        // The same event id twice means the event is already there.
        409 => Ok(json!({"result":"ok","created":false,"eventId":p["event"]["id"]})),
        _ => Err(refused(&r, "calendar-insert")),
    }))
}

async fn patch(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    deadline: Instant,
) -> Result<Answer> {
    let event = store::text(p, "eventId")?;
    let body = json!({"start":p["start"],"end":p["end"]});
    let url = calendar_url(config, calendar_id(p), &format!("/events/{}", urlencode(event)))?;
    let sent = write(cx, cipher, config, Method::PATCH, url, Some(body), "calendar-patch", deadline).await?;
    Ok(sent.and_then(|r| match r.status {
        200..=299 => Ok(json!({"result":"ok","eventId":r.body["id"]})),
        404 | 410 => Ok(json!({"result":"gone"})),
        _ => Err(refused(&r, "calendar-patch")),
    }))
}

async fn delete(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    deadline: Instant,
) -> Result<Answer> {
    let event = store::text(p, "eventId")?;
    let url = calendar_url(config, calendar_id(p), &format!("/events/{}", urlencode(event)))?;
    let sent = write(cx, cipher, config, Method::DELETE, url, None, "calendar-delete", deadline).await?;
    Ok(sent.and_then(|r| match r.status {
        200..=299 => Ok(json!({"result":"ok","deleted":"deleted"})),
        404 | 410 => Ok(json!({"result":"ok","deleted":"already-gone"})),
        _ => Err(refused(&r, "calendar-delete")),
    }))
}

/// A mail send over SMTP, or a draft saved with APPEND. The login comes from the sealed
/// secret of the person's own account.
async fn imap(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &MailConfig,
    id: Uuid,
    request: &Request,
    deadline: Instant,
) -> Result<Value> {
    let p = &request.parameters;
    let text = mime(p)?;
    let Some(login) = login(cx, cipher, config, id).await? else {
        return Ok(json!({"result":"inactive"}));
    };
    // The package never learns the login name, so the host adds the sender header.
    let text = format!("From: {}\r\n{text}", login.username.replace(['\r', '\n'], ""));
    let text = text.as_str();
    let left = deadline.saturating_duration_since(Instant::now());
    // Set once the mail has gone, so a later stall cannot turn the send into a reported failure.
    let gone = std::cell::Cell::new(false);
    let work = async {
        if request.resource == "connectors.write-imap-send" {
            let to: lettre::Address = store::text(p, "to")?.parse().map_err(|_| anyhow!("Invalid recipient"))?;
            let from: lettre::Address = login.username.parse().map_err(|_| anyhow!("Invalid sender"))?;
            let envelope = Envelope::new(Some(from), vec![to])?;
            let Some(transport) = smtp_transport(&login.servers, &login.trust, &login.username, &login.password)
            else {
                return Ok(json!({"result":"unreachable"}));
            };
            if let Err(e) = transport.send_raw(&envelope, text.as_bytes()).await {
                let tls = is_tls_error(&e) || e.is_tls();
                let auth = e.status().is_some_and(|c| matches!(u16::from(c), 530 | 534 | 535 | 538));
                let result = if auth { "auth_failed" } else if tls { "tls_failed" } else { "failed" };
                return Ok(json!({"result":result}));
            }
            gone.set(true);
            // The copy in Sent is best effort. The mail has already gone.
            let filed = file(&login, text, true).await;
            return Ok(json!({"result":"ok","filed":filed.is_ok()}));
        }
        match file(&login, text, false).await {
            Ok(()) => Ok(json!({"result":"ok"})),
            Err(fail) => Ok(fail.answer()),
        }
    };
    match tokio::time::timeout(left, work).await {
        Ok(answer) => answer,
        Err(_) if gone.get() => Ok(json!({"result":"ok","filed":false})),
        Err(_) => Ok(json!({"result":"unreachable"})),
    }
}

/// Saves a copy in the Sent folder, or a draft in the Drafts folder, creating it when missing.
async fn file(login: &crate::imap_sync::Login, text: &str, sent: bool) -> std::result::Result<(), crate::imap_sync::Fail> {
    use async_imap::types::NameAttribute;
    use crate::imap_sync::Fail;
    let mut session = open(login).await?;
    let wanted = if sent { NameAttribute::Sent } else { NameAttribute::Drafts };
    let fallback = if sent { "Sent" } else { "Drafts" };
    let names: Vec<_> = session
        .list(Some(""), Some("*"))
        .await
        .map_err(|_| Fail::Unreachable)?
        .try_collect()
        .await
        .map_err(|_| Fail::Unreachable)?;
    let found = names
        .iter()
        .find(|n| n.attributes().contains(&wanted))
        .or_else(|| names.iter().find(|n| n.name().eq_ignore_ascii_case(fallback)))
        .map(|n| n.name().to_string());
    let folder = match found {
        Some(name) => name,
        None => {
            session.create(fallback).await.map_err(|_| Fail::Unreachable)?;
            fallback.to_string()
        }
    };
    let flags = if sent { "(\\Seen)" } else { "(\\Draft)" };
    let outcome = session
        .append(&folder, Some(flags), None, text.as_bytes())
        .await
        .map_err(|_| Fail::Unreachable);
    let _ = session.logout().await;
    outcome
}
