//! Live reads for source context and the read tools. The host reads the signed-in person's
//! Gmail and Google Calendar and answers the package with trimmed rows. Tokens never leave
//! the host, and a failure answer holds only a status, a cleaned reason and the call name.
use crate::google::GoogleConfig;
use crate::google_parse::{calendar_event, gmail_message};
use crate::google_sync::{call, list_url, urlencode, Failure};
use crate::store;
use anyhow::{anyhow, bail, Result};
use base64::Engine;
use moss_module_host::runtime::Request;
use portability::secrets::JsonSecretCipher;
use safety_core::db::DataContext;
use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};
use uuid::Uuid;

/// A live tool call must finish inside the five seconds the host gives a package call.
const BUDGET: Duration = Duration::from_millis(3000);
const CALENDAR_PAGE: &str = "250";
const CALENDAR_PAGES: usize = 3;
const BODY_CHARS: usize = 20_000;
const LIST_MAX: usize = 20;

pub async fn run(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    request: &Request,
) -> Result<Value> {
    let p = &request.parameters;
    if request.resource == "connectors.context-setup" {
        return setup(cx).await;
    }
    let id = Uuid::parse_str(store::text(p, "accountId")?).map_err(|_| anyhow!("Invalid account"))?;
    if !active_google(cx, id).await? {
        return Ok(json!({"result":"inactive"}));
    }
    let deadline = Instant::now() + BUDGET;
    let answer = match request.resource.as_str() {
        "connectors.live-calendar" => calendar(cx, cipher, config, p, deadline).await?,
        "connectors.live-gmail-list" => gmail_list(cx, cipher, config, p, deadline).await?,
        "connectors.live-gmail-get" => gmail_get(cx, cipher, config, p, deadline).await?,
        _ => bail!("Unknown connectors resource"),
    };
    Ok(answer.unwrap_or_else(|failure| failure.answer()))
}

/// The account must be the signed-in person's own, active and Google. Row-level security keeps
/// every other person's accounts out of this query.
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

/// What the package needs to decide per account: the safe account rows, their saved feature
/// grants, the Outlook helper health and the saved time zone.
async fn setup(cx: &DataContext) -> Result<Value> {
    let accounts = store::accounts(cx, "", None).await?;
    let (mut grants, mut outlook) = (Map::new(), Map::new());
    for account in &accounts {
        let id = account["id"].as_str().unwrap_or("");
        grants.insert(id.into(), store::preference(cx, &moss_connectors::grants::key(id)).await?);
        if account["providerId"] == moss_connectors::health::OUTLOOK_PROVIDER {
            outlook.insert(id.into(), store::preference(cx, &moss_connectors::health::outlook_key(id)).await?);
        }
    }
    let locale = store::preference(cx, "locale").await?;
    Ok(json!({"accounts":accounts,"grants":grants,"outlook":outlook,"timezone":locale["timezone"]}))
}

async fn calendar(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    deadline: Instant,
) -> Result<std::result::Result<Value, Failure>> {
    let (min, max) = (store::text(p, "timeMin")?, store::text(p, "timeMax")?);
    let mut events = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..CALENDAR_PAGES {
        let mut query = vec![
            ("timeMin", min), ("timeMax", max), ("singleEvents", "true"),
            ("orderBy", "startTime"), ("maxResults", CALENDAR_PAGE),
        ];
        if let Some(token) = token.as_deref() {
            query.push(("pageToken", token));
        }
        let url = list_url(config.calendar_base(), "calendars/primary/events", &query)?;
        let page = match call(cx, cipher, config, url, "calendar.events.list", deadline).await? {
            Ok(page) => page,
            Err(failure) => return Ok(Err(failure)),
        };
        events.extend(page["items"].as_array().into_iter().flatten().filter_map(calendar_event));
        token = page["nextPageToken"].as_str().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(Ok(json!({"events":events})))
}

const HEADERS: [&str; 6] = ["From", "To", "Cc", "Subject", "Message-ID", "References"];

async fn one_message(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    id: &str,
    full: bool,
    deadline: Instant,
) -> Result<std::result::Result<Value, Failure>> {
    let mut query = vec![("format", if full { "full" } else { "metadata" })];
    if !full {
        query.extend(HEADERS.map(|h| ("metadataHeaders", h)));
    }
    let url = list_url(config.gmail_base(), &format!("users/me/messages/{}", urlencode(id)), &query)?;
    call(cx, cipher, config, url, "gmail.messages.get", deadline).await
}

/// The newest matching messages. Reads run side by side so ten messages fit the budget, and a
/// message that cannot be read is counted as skipped.
async fn gmail_list(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    deadline: Instant,
) -> Result<std::result::Result<Value, Failure>> {
    let limit = p["limit"].as_u64().unwrap_or(10).clamp(1, LIST_MAX as u64) as usize;
    let max = limit.to_string();
    let query = [("q", p["query"].as_str().unwrap_or("newer_than:30d")), ("maxResults", max.as_str())];
    let url = list_url(config.gmail_base(), "users/me/messages", &query)?;
    let page = match call(cx, cipher, config, url, "gmail.messages.list", deadline).await? {
        Ok(page) => page,
        Err(failure) => return Ok(Err(failure)),
    };
    let ids: Vec<String> = page["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().map(String::from))
        .take(limit)
        .collect();
    let reads = ids.iter().map(|id| one_message(cx, cipher, config, id, false, deadline));
    let (mut messages, mut skipped) = (Vec::new(), 0);
    for read in futures_util::future::join_all(reads).await {
        match read? {
            Ok(message) => match gmail_message(&message) {
                Some(parsed) => messages.push(summary(&parsed)),
                None => skipped += 1,
            },
            Err(failure) if failure.sign_in => return Ok(Err(failure)),
            Err(_) => skipped += 1,
        }
    }
    Ok(Ok(json!({"messages":messages,"skipped":skipped})))
}

async fn gmail_get(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
    deadline: Instant,
) -> Result<std::result::Result<Value, Failure>> {
    let id = store::text(p, "id")?;
    let message = match one_message(cx, cipher, config, id, true, deadline).await? {
        Ok(message) => message,
        Err(failure) => return Ok(Err(failure)),
    };
    let Some(parsed) = gmail_message(&message) else {
        return Ok(Ok(json!({"message":null})));
    };
    let mut out = summary(&parsed);
    out["bodyText"] = json!(body_text(&message["payload"]));
    Ok(Ok(json!({"message":out})))
}

fn summary(parsed: &Value) -> Value {
    json!({
        "id": parsed["externalId"], "threadId": parsed["threadId"], "from": parsed["sender"],
        "to": parsed["recipients"], "subject": parsed["subject"], "snippet": parsed["snippet"],
        "receivedAt": parsed["receivedAt"], "labelIds": parsed["labelIds"],
    })
}

fn decode(data: &str) -> String {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(data.trim_end_matches('='))
        .unwrap_or_default();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn strip_html(html: &str) -> String {
    let (mut out, mut tag, mut skip_until) = (String::new(), false, None::<&str>);
    let lower = html.to_lowercase();
    let mut i = 0;
    while i < html.len() {
        if !html.is_char_boundary(i) {
            i += 1;
            continue;
        }
        let rest = &lower[i..];
        if let Some(end) = skip_until {
            if rest.starts_with(end) {
                skip_until = None;
                i += end.len();
            } else {
                i += 1;
            }
            continue;
        }
        if rest.starts_with("<style") {
            skip_until = Some("</style>");
        } else if rest.starts_with("<script") {
            skip_until = Some("</script>");
        }
        let c = html[i..].chars().next().unwrap_or(' ');
        match c {
            '<' => tag = true,
            '>' if tag => {
                tag = false;
                out.push(' ');
            }
            _ if !tag => out.push(c),
            _ => {}
        }
        i += c.len_utf8();
    }
    out.replace("&nbsp;", " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The plain text of a message, or its HTML with tags removed. Capped before it reaches the package.
fn body_text(payload: &Value) -> String {
    fn walk(part: &Value, text: &mut String, html: &mut String) {
        if text.len() >= BODY_CHARS && html.len() >= BODY_CHARS {
            return;
        }
        let (mime, data) = (part["mimeType"].as_str().unwrap_or(""), part["body"]["data"].as_str());
        match (mime, data) {
            ("text/plain", Some(data)) if text.len() < BODY_CHARS => text.push_str(&decode(data)),
            ("text/html", Some(data)) if html.len() < BODY_CHARS => html.push_str(&decode(data)),
            _ => {}
        }
        for child in part["parts"].as_array().into_iter().flatten() {
            walk(child, text, html);
        }
    }
    let (mut text, mut html) = (String::new(), String::new());
    walk(payload, &mut text, &mut html);
    let body = if text.trim().is_empty() { strip_html(&html) } else { text };
    body.chars().take(BODY_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(mime: &str, text: &str) -> Value {
        let data = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text);
        json!({"mimeType":mime,"body":{"data":data}})
    }

    #[test]
    fn plain_text_wins_over_html() {
        let payload = json!({"mimeType":"multipart/alternative","parts":[part("text/plain","Hello there"),part("text/html","<p>Other</p>")]});
        assert_eq!(body_text(&payload), "Hello there");
    }

    #[test]
    fn html_loses_tags_styles_and_scripts() {
        let html = "<style>p{}</style><p>Hi&nbsp;<b>you</b></p><script>x()</script>";
        assert_eq!(body_text(&part("text/html", html)), "Hi you");
    }

    #[test]
    fn a_huge_body_is_cut_to_the_cap() {
        let big = "a".repeat(BODY_CHARS * 2);
        assert_eq!(body_text(&part("text/plain", &big)).len(), BODY_CHARS);
    }

    #[test]
    fn the_summary_names_the_fields_the_tool_returns() {
        let parsed = json!({"externalId":"m","threadId":"t","sender":"a","recipients":["b"],"subject":"s",
            "snippet":null,"receivedAt":"x","labelIds":[],"historyId":"9","references":["r"]});
        let out = summary(&parsed);
        assert_eq!(out["id"], "m");
        assert!(out.get("historyId").is_none() && out.get("references").is_none());
    }
}
