//! The thread provider and the monitor provider. Other modules call these through Email's
//! public API. Both read only the signed-in person's cached mail and hand back trimmed shapes.
use crate::{kv, Error, Result};
use moss_module_sdk::Host;
use serde_json::{json, Value};

/// Longest body excerpt handed to a thread judgement, per message.
pub const THREAD_EXCERPT_CAP: usize = 4_000;
const RECENT_HOURS: i64 = 48;
const EXPIRY_DAYS: i64 = 7;
const TITLE_CHARS: usize = 200;
const DEFAULT_SIGNALS: usize = 20;
const MAX_SIGNALS: usize = 100;

/// The bare, lower-cased address of a sender header such as `Sarah Kim <Sarah@Kim.Example>`.
pub fn sender_address(from: &str) -> String {
    let inner = from
        .find('<')
        .and_then(|open| from[open + 1..].find('>').map(|close| &from[open + 1..open + 1 + close]));
    inner.unwrap_or(from).trim().to_lowercase()
}

fn user_addresses(input: &Value) -> Vec<String> {
    input["userAddresses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a.as_str().map(|a| a.trim().to_lowercase()))
        .collect()
}

fn shape(row: &Value, mine: &[String]) -> Value {
    let address = sender_address(row["sender"].as_str().unwrap_or(""));
    json!({
        "externalId": row["externalId"], "cacheMessageId": row["cacheMessageId"],
        "fromIsUser": mine.contains(&address), "fromAddress": address,
        "subject": row["subject"].as_str().unwrap_or(""), "receivedAt": row["receivedAt"],
        "bodyExcerpt": row["bodyExcerpt"].as_str().unwrap_or("").chars().take(THREAD_EXCERPT_CAP).collect::<String>(),
    })
}

pub fn thread_messages(host: &impl Host, input: &Value) -> Result<Value> {
    let Some(reference) = input["threadRef"].as_str().filter(|r| !r.is_empty()) else {
        return Err(Error::new(400, "threadRef is required"));
    };
    let mine = user_addresses(input);
    let rows = kv(host, "get", "email.thread", json!({"mode":"thread","threadRef":reference}))?;
    let messages: Vec<Value> = rows.as_array().into_iter().flatten().map(|r| shape(r, &mine)).collect();
    Ok(json!({"messages":messages}))
}

pub fn newer_threads(host: &impl Host, input: &Value) -> Result<Value> {
    let mine = user_addresses(input);
    let rows = kv(host, "get", "email.thread", json!({"mode":"newer","threads":input["threads"]}))?;
    let threads: Vec<Value> = rows
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| json!({"threadRef":r["threadRef"],"newest":shape(&r["newest"], &mine)}))
        .collect();
    Ok(json!({"threads":threads}))
}

const REPLY: [&str; 7] = ["reply", "respond", "let me know", "can you", "please review", "follow up", "question"];

fn has_by_date(text: &str) -> bool {
    // "by <word> <digit>", for example "by friday 5".
    let words: Vec<&str> = text.split_whitespace().collect();
    words.windows(3).any(|w| {
        w[0] == "by" && w[1].chars().all(|c| c.is_ascii_alphabetic()) && w[2].starts_with(|c: char| c.is_ascii_digit())
    })
}

fn needs_reply(lower: &str) -> bool {
    REPLY.iter().any(|p| lower.contains(p)) || lower.contains("action needed")
}

fn is_urgent(lower: &str) -> bool {
    let timed = lower.find("time").is_some_and(|i| {
        let rest = &lower[i + 4..];
        rest.chars().next().is_some() && rest.chars().skip(1).collect::<String>().starts_with("sensitive")
    });
    lower.contains("urgent") || lower.contains("asap") || lower.contains("deadline") || timed || has_by_date(lower)
}

const SECRET_QUERY: [&str; 8] =
    ["token", "access_token", "session", "auth", "api_key", "apikey", "secret", "code"];
const SECRET_WORDS: [&str; 9] = [
    "password", "passwd", "api key", "api_key", "api-key", "secret key", "auth token", "session token", "private key",
];

fn link_has_secret(link: &str) -> bool {
    let Some((_, query)) = link.split_once('?') else { return false };
    query.split(['&', '#']).any(|pair| {
        let name = pair.split('=').next().unwrap_or("").to_lowercase();
        SECRET_QUERY.contains(&name.as_str()) || name == "client_secret" || name == "refresh_token"
    })
}

/// Removes links that carry credentials, bearer values and lines that assign a secret.
pub fn sanitize(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.lines() {
        let lower = line.to_lowercase();
        let assigns = SECRET_WORDS.iter().chain(["access token", "access_token"].iter()).any(|w| {
            lower.find(w).is_some_and(|i| {
                let rest = lower[i + w.len()..].trim_start();
                (rest.starts_with(':') || rest.starts_with('=')) && rest[1..].trim().len() > 0
            })
        });
        if assigns {
            lines.push("[redacted]".to_string());
            continue;
        }
        let mut words = Vec::new();
        let mut parts = line.split(' ').peekable();
        while let Some(word) = parts.next() {
            let is_link = word.starts_with("http://") || word.starts_with("https://");
            if is_link && link_has_secret(word) {
                words.push("[link removed]".to_string());
            } else if word.eq_ignore_ascii_case("bearer") && parts.peek().is_some_and(|n| n.len() >= 6) {
                parts.next();
                words.push("[redacted]".to_string());
            } else {
                words.push(word.to_string());
            }
        }
        lines.push(words.join(" "));
    }
    lines.join("\n")
}

fn cut(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

fn plus_days(time: &str, days: i64) -> Option<String> {
    let at = chrono::DateTime::parse_from_rfc3339(time).ok()?;
    Some((at + chrono::Duration::days(days)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Cached messages of the named accounts from the last 48 hours that read as needing a reply or
/// as time sensitive. The caller names the accounts whose email feature is switched on.
pub fn monitor_signals(host: &impl Host, input: &Value) -> Result<Value> {
    let accounts = input["accountIds"].clone();
    if accounts.as_array().map_or(true, Vec::is_empty) {
        return Ok(json!({"signals":[]}));
    }
    let clock = host.call("context", "read", "call", json!({}))?;
    let now = chrono::DateTime::parse_from_rfc3339(clock["now"].as_str().unwrap_or(""))
        .map_err(|_| Error::new(503, "Email clock is unavailable"))?;
    let since = (now - chrono::Duration::hours(RECENT_HOURS)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let max = input["maxSignals"].as_u64().map_or(DEFAULT_SIGNALS, |m| (m as usize).min(MAX_SIGNALS));
    let rows = kv(host, "get", "email.recent", json!({"mode":"recent","accountIds":accounts,"since":since}))?;
    let mut signals = Vec::new();
    for row in rows.as_array().into_iter().flatten() {
        if signals.len() >= max {
            break;
        }
        let (subject, snippet) = (row["subject"].as_str().unwrap_or(""), row["snippet"].as_str());
        let text = [subject, snippet.unwrap_or(""), row["summary"].as_str().unwrap_or("")].join(" ").to_lowercase();
        let (reply, urgent) = (needs_reply(&text), is_urgent(&text));
        if !reply && !urgent {
            continue;
        }
        let hash = row["hash"].as_str().unwrap_or("");
        let received = row["receivedAt"].as_str().unwrap_or("");
        let summary = match snippet {
            Some(s) if !s.is_empty() => cut(&sanitize(s), TITLE_CHARS),
            _ if urgent => "Time-sensitive message needs attention".to_string(),
            _ => "Message likely needs a reply".to_string(),
        };
        signals.push(json!({
            "source": "email", "stableKey": format!("email:{hash}"), "sourceRefHash": hash,
            "signalType": if urgent { "time_sensitive_follow_up" } else { "needs_reply_soon" },
            "title": cut(&sanitize(subject), TITLE_CHARS), "summary": summary,
            "occurredAt": received, "expiresAt": plus_days(received, EXPIRY_DAYS),
            "priorityCandidate": {},
        }));
    }
    Ok(json!({"signals":signals,"checkedAt":now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}))
}
