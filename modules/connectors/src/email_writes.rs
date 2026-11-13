//! `email.draftReply` and `email.sendReply`. The model supplies only the cached message id and
//! the body. The recipient, subject and thread come from the signed-in person's own cached
//! message, so a reply can never be addressed anywhere else. The host holds the credentials and
//! makes the one call. Mail text appears only in the params of that call and in the card.
use crate::{grants, kv, Error, Result};
use moss_module_sdk::{Client, Host};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const GONE: &str = "That message isn't in your inbox anymore — it may have been removed.";
const UNSUPPORTED: &str = "Replies aren't supported for this account yet.";
const NO_SCOPE: &str = "Your Google connection doesn't have send permission yet — reconnect in Settings to grant it.";
const DISABLED: &str = "Email access is disabled for this account in Settings.";
const NO_THREAD: &str = "Couldn't find the original conversation to reply to.";
const CONNECT: &str = "Connect Google in Settings first.";
const REFRESH: &str = "Couldn't refresh your Google access — reconnect in Settings.";
const FAILED: &str = "Couldn't send your reply right now — try again.";
const DRAFT_FAILED: &str = "Couldn't save your draft right now — try again.";
const CHANGED: &str = "The reply changed after it was shown. Review it again before sending.";
const BODY_MAX: usize = 100_000;

struct Reply {
    account: String,
    google: bool,
    to_header: String,
    to_address: String,
    subject: String,
    thread: String,
    in_reply_to: String,
    references: Vec<String>,
    body: String,
}

fn clean(value: &str) -> String {
    value.replace(['\r', '\n'], " ").trim().to_string()
}

/// The bare address of a sender such as `Ann <ann@example.com>`.
fn address(sender: &str) -> String {
    let inner = match (sender.rfind('<'), sender.rfind('>')) {
        (Some(open), Some(close)) if open < close => &sender[open + 1..close],
        _ => sender,
    };
    inner.trim().to_string()
}

fn bracket(id: &str) -> String {
    format!("<{}>", id.trim().trim_start_matches('<').trim_end_matches('>'))
}

fn derive(host: &impl Host, cache_id: &str, body: &str) -> Result<std::result::Result<Reply, &'static str>> {
    let found = Client(host).api("email", "replyContext", json!({"cacheMessageId":cache_id}))?;
    let sender = clean(found["sender"].as_str().unwrap_or(""));
    if found.is_null() || address(&sender).is_empty() {
        return Ok(Err(GONE));
    }
    let account_id = found["accountId"].as_str().unwrap_or("").to_string();
    let setup = kv(host, "get", "connectors.context-setup", json!({}))?;
    let account = setup["accounts"].as_array().into_iter().flatten().find(|a| a["id"] == account_id.as_str());
    let Some(account) = account.filter(|a| a["status"] == "active") else {
        return Ok(Err(GONE));
    };
    let google = match account["providerType"].as_str() {
        Some("google") => true,
        Some("imap") => false,
        _ => return Ok(Err(UNSUPPORTED)),
    };
    if google {
        let scoped = account["scopes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|s| s.as_str() == Some("https://www.googleapis.com/auth/gmail.modify"));
        if !scoped {
            return Ok(Err(NO_SCOPE));
        }
    }
    if !grants::is_granted(&setup["grants"][account_id.as_str()], "email") {
        return Ok(Err(DISABLED));
    }
    let references: Vec<String> = found["references"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str().map(clean))
        .filter(|r| !r.is_empty())
        .collect();
    let message_id = clean(found["messageId"].as_str().unwrap_or(""));
    let thread = if google {
        clean(found["threadId"].as_str().unwrap_or(""))
    } else {
        references.first().cloned().unwrap_or_else(|| message_id.clone())
    };
    if google && thread.is_empty() || !google && message_id.is_empty() {
        return Ok(Err(NO_THREAD));
    }
    let original = clean(found["subject"].as_str().unwrap_or(""));
    let subject = if original.to_ascii_lowercase().starts_with("re:") { original } else { format!("Re: {original}") };
    Ok(Ok(Reply {
        account: account_id,
        google,
        to_address: address(&sender),
        to_header: sender,
        subject,
        thread,
        in_reply_to: message_id,
        references,
        body: body.to_string(),
    }))
}

/// The version of exactly what will be sent. The approval stores it and the send must match it.
fn version(reply: &Reply) -> String {
    let mut hash = Sha256::new();
    for part in [&reply.to_address, &reply.subject, &reply.thread, &reply.body] {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn subject_header(subject: &str) -> String {
    if subject.is_ascii() {
        subject.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", base64(subject.as_bytes()))
    }
}

/// Plain text UTF-8 with CRLF line ends. The host adds the sender header for IMAP and Gmail
/// adds its own.
fn mime(reply: &Reply) -> String {
    let mut head = vec![
        format!("To: {}", reply.to_header),
        format!("Subject: {}", subject_header(&reply.subject)),
    ];
    if !reply.in_reply_to.is_empty() {
        head.push(format!("In-Reply-To: {}", bracket(&reply.in_reply_to)));
        let mut chain: Vec<String> = reply.references.iter().map(|r| bracket(r)).collect();
        chain.push(bracket(&reply.in_reply_to));
        head.push(format!("References: {}", chain.join(" ")));
    }
    head.push("MIME-Version: 1.0".into());
    head.push("Content-Type: text/plain; charset=UTF-8".into());
    head.push("Content-Transfer-Encoding: 8bit".into());
    let body = reply.body.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n");
    format!("{}\r\n\r\n{}", head.join("\r\n"), body)
}

fn outcome(ok: bool, mode: &str, message: Option<&str>) -> Value {
    let mut data = json!({"ok":ok,"mode":mode});
    if let Some(message) = message {
        data["message"] = json!(message);
    }
    json!({"data":data})
}

fn input<'a>(parameters: &'a Value) -> std::result::Result<(&'a str, &'a str), Error> {
    let id = parameters["cacheMessageId"].as_str().unwrap_or("").trim();
    let body = parameters["body"].as_str().unwrap_or("");
    if id.is_empty() {
        return Err(Error::new(400, "cacheMessageId is required"));
    }
    if body.trim().is_empty() || body.len() > BODY_MAX {
        return Err(Error::new(400, "A reply body is required and must be under 100,000 characters"));
    }
    Ok((id, body))
}

/// The card shown before a send. It never grants approval.
pub fn prepare(host: &impl Host, parameters: &Value) -> Result<Value> {
    let (id, body) = input(parameters)?;
    match derive(host, id, body)? {
        Ok(reply) => Ok(json!({
            "title": "Send this reply?",
            "content": "user_authored",
            "target": reply.to_address,
            "fields": [
                {"label":"To","value":reply.to_header},
                {"label":"Subject","value":reply.subject},
                {"label":"Reply","value":reply.body},
            ],
            "version": version(&reply),
        })),
        Err(message) => Err(Error::new(409, message)),
    }
}

/// `send` needs the version the person approved. A draft never sends, so it needs none.
pub fn run(host: &impl Host, send: bool, parameters: &Value, approved: Option<&str>) -> Result<Value> {
    let mode = if send { "sent" } else { "drafted" };
    let (id, body) = input(parameters)?;
    let reply = match derive(host, id, body)? {
        Ok(reply) => reply,
        Err(message) => return Ok(outcome(false, mode, Some(message))),
    };
    if send && approved != Some(version(&reply).as_str()) {
        return Ok(outcome(false, mode, Some(CHANGED)));
    }
    let text = mime(&reply);
    let (resource, params) = match (reply.google, send) {
        (true, true) => ("connectors.write-gmail-send", json!({"accountId":reply.account,"mime":text,"threadId":reply.thread})),
        (true, false) => ("connectors.write-gmail-draft", json!({"accountId":reply.account,"mime":text,"threadId":reply.thread})),
        (false, true) => ("connectors.write-imap-send", json!({"accountId":reply.account,"mime":text,"to":reply.to_address})),
        (false, false) => ("connectors.write-imap-draft", json!({"accountId":reply.account,"mime":text})),
    };
    let wrote = kv(host, "set", resource, params)?;
    Ok(match wrote["result"].as_str() {
        Some("ok") => outcome(true, mode, None),
        Some("inactive") => outcome(false, mode, Some(if reply.google { CONNECT } else { GONE })),
        Some("auth_failed") if reply.google => outcome(false, mode, Some(REFRESH)),
        _ => outcome(false, mode, Some(if send { FAILED } else { DRAFT_FAILED })),
    })
}
