//! Google sync in the host. It reads the signed-in person's Gmail and Calendar over the stored
//! sign-in and hands normalized rows to the package, which writes them through Email and
//! Calendar. Tokens, page positions and the Gmail anchor stay here. Answers carry no token,
//! no response body and no Google error text.
use crate::google::{self, GoogleConfig, RefreshFailure};
use crate::google_parse::{calendar_event, gmail_message};
use crate::store;
use anyhow::{anyhow, bail, Result};
use chrono::{DateTime, Duration as Days, Utc};
use moss_module_host::runtime::Request;
use portability::secrets::JsonSecretCipher;
use safety_core::db::DataContext;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use url::Url;
use uuid::Uuid;

const PAGE: usize = 100;
const ATTEMPTS: u32 = 3;
const WINDOW_DAYS: i64 = 30;
const PAST_DAYS: i64 = 7;
const ERRORS: [&str; 4] = ["auth-error", "calendar-error", "email-error", "email-message-error"];
const TRIGGERS: [&str; 4] = ["schedule", "manual", "assistant", "on-connect"];
const RATE_REASONS: [&str; 6] = [
    "ratelimitexceeded", "userratelimitexceeded", "rate_limit_exceeded", "resourceexhausted",
    "resource_exhausted", "quotaexceeded",
];

/// Where each running sync stands. Lost on a restart, which makes the next run start over.
#[derive(Default)]
pub struct SyncRuns(Mutex<HashMap<Uuid, Run>>);

#[derive(Default)]
struct Run {
    started: Option<DateTime<Utc>>,
    /// The page token that opens page N of a list, per list name.
    pages: HashMap<String, Vec<Option<String>>>,
    mode: Option<String>,
    anchor: Option<String>,
    /// The first failure of the run: status, cleaned reason and the call name.
    detail: Option<Value>,
}

/// Why a Google call gave nothing. Holds only the status, a cleaned reason and the call name.
struct Failure {
    status: Option<u16>,
    reason: Option<String>,
    operation: &'static str,
    sign_in: bool,
}

impl Failure {
    fn answer(&self) -> Value {
        let result = if self.sign_in { "auth_failed" } else { "failed" };
        json!({"result":result,"error":{"status":self.status,"reason":self.reason,"operation":self.operation}})
    }
}

type Fetched = std::result::Result<Value, Failure>;

fn clean(text: &str) -> Option<String> {
    let kept: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .take(64)
        .collect();
    (!kept.is_empty()).then_some(kept)
}

fn reason_of(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let error = &value["error"];
    error["errors"][0]["reason"]
        .as_str()
        .or_else(|| error["details"][0]["reason"].as_str())
        .or_else(|| error["status"].as_str())
        .and_then(clean)
}

fn retryable(status: u16, reason: &Option<String>) -> bool {
    matches!(status, 408 | 429 | 500..=599)
        || reason.as_deref().is_some_and(|r| RATE_REASONS.contains(&r.to_ascii_lowercase().as_str()))
}

/// One Google read, retried on transient refusals and refreshed once on a 401.
async fn call(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    url: Url,
    operation: &'static str,
) -> Result<Fetched> {
    let fail = |status, reason, sign_in| Err(Failure { status, reason, operation, sign_in });
    let mut token = match google::fresh_access_token(cx, cipher, config, false).await? {
        Ok(token) => token,
        Err(RefreshFailure::NeedsSignIn) => return Ok(fail(None, None, true)),
        Err(_) => return Ok(fail(None, None, false)),
    };
    let (mut attempt, mut refreshed) = (1, false);
    loop {
        let Ok((status, body)) = config.get(url.clone(), &token).await else {
            return Ok(fail(None, None, false));
        };
        if (200..300).contains(&status) {
            return Ok(serde_json::from_slice(&body).or_else(|_| fail(Some(status), None, false)));
        }
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
        let reason = reason_of(&body);
        if status == 401 {
            return Ok(fail(Some(401), reason, true));
        }
        if attempt < ATTEMPTS && retryable(status, &reason) {
            let jitter = Duration::from_nanos(Utc::now().timestamp_subsec_nanos() as u64 % 100_000_000)
                .min(config.retry_delay());
            tokio::time::sleep(config.retry_delay() * attempt + jitter).await;
            attempt += 1;
            continue;
        }
        return Ok(fail(Some(status), reason, false));
    }
}

pub async fn run(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    runs: &SyncRuns,
    request: &Request,
) -> Result<Value> {
    let p = &request.parameters;
    let id = Uuid::parse_str(store::text(p, "accountId")?).map_err(|_| anyhow!("Invalid account"))?;
    match request.resource.as_str() {
        "connectors.sync-google-start" => start(cx, config, runs, id, p).await,
        "connectors.sync-google-finish" => finish(cx, runs, id, p).await,
        "connectors.sync-google-calendar" | "connectors.sync-google-list" | "connectors.sync-google-fetch" => {
            let live = cx
                .db()
                .query_opt(
                    "SELECT 1 FROM app.connector_accounts WHERE id = $1 AND status = 'active' AND provider_id = 'google'",
                    &[&id],
                )
                .await?;
            if live.is_none() {
                return Ok(json!({"result":"inactive"}));
            }
            let answer = match request.resource.as_str() {
                "connectors.sync-google-calendar" => calendar(cx, cipher, config, runs, id, p).await?,
                "connectors.sync-google-list" => list(cx, cipher, config, runs, id, p).await?,
                _ => fetch(cx, cipher, config, runs, id, p).await?,
            };
            let answer = answer.unwrap_or_else(|failure| failure.answer());
            let detail = &answer["error"];
            if detail.is_object() {
                if let Some(run) = runs.0.lock().expect("runs").get_mut(&id) {
                    run.detail.get_or_insert_with(|| detail.clone());
                }
            }
            Ok(answer)
        }
        _ => bail!("Unknown connectors resource"),
    }
}

fn iso(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

async fn granted(cx: &DataContext, id: Uuid, scope: &str, feature: &str, scopes: &[String]) -> Result<bool> {
    let key = format!("connector.{id}.feature_grants");
    let row = cx.db().query_opt("SELECT value_json FROM app.preferences WHERE key = $1", &[&key]).await?;
    let on = row.map_or(true, |row| row.get::<_, Value>(0)[feature] != false);
    Ok(on && scopes.iter().any(|s| s == scope))
}

/// Marks a run as started and keeps the finished run before it. A run already going, and an
/// account that is revoked or not Google, start nothing.
async fn start(cx: &DataContext, config: &GoogleConfig, runs: &SyncRuns, id: Uuid, p: &Value) -> Result<Value> {
    let trigger = p["trigger"].as_str().filter(|t| TRIGGERS.contains(t)).unwrap_or("schedule");
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
               last_sync_trigger = $2
             WHERE id = $1 AND status = 'active' AND provider_id = 'google'
               AND (last_sync_status IS NOT NULL OR last_sync_started_at IS NULL
                    OR last_sync_started_at < now() - interval '840 seconds')",
            &[&id, &trigger],
        )
        .await?;
    if started == 0 {
        let live = cx
            .db()
            .query_opt(
                "SELECT 1 FROM app.connector_accounts WHERE id = $1 AND status = 'active' AND provider_id = 'google'",
                &[&id],
            )
            .await?;
        return Ok(json!({"state": if live.is_some() { "busy" } else { "inactive" }}));
    }
    let scopes: Vec<String> = cx
        .db()
        .query_one("SELECT scopes FROM app.connector_accounts WHERE id = $1", &[&id])
        .await?
        .get(0);
    let email = granted(cx, id, "https://www.googleapis.com/auth/gmail.modify", "email", &scopes).await?;
    let calendar = granted(cx, id, "https://www.googleapis.com/auth/calendar", "calendar", &scopes).await?;
    runs.0.lock().expect("runs").insert(id, Run { started: Some(config.now()), ..Run::default() });
    Ok(json!({"state":"started","email":email,"calendar":calendar}))
}

fn count(p: &Value, name: &str) -> i64 {
    p["counts"][name].as_i64().unwrap_or(0).clamp(0, 1_000_000)
}

async fn finish(cx: &DataContext, runs: &SyncRuns, id: Uuid, p: &Value) -> Result<Value> {
    let status = store::text(p, "status")?;
    if !["success", "partial", "failed"].contains(&status) {
        bail!("Invalid sync status");
    }
    let error = p["error"].as_str().filter(|e| ERRORS.contains(e));
    let mut counts = json!({
        "calendarUpserted":count(p, "calendarUpserted"),"calendarReconciled":count(p, "calendarReconciled"),
        "emailUpserted":count(p, "emailUpserted"),"emailFailures":count(p, "emailFailures"),
        "escalations":0,"truncated":p["counts"]["truncated"].as_bool().unwrap_or(false),
    });
    let run = runs.0.lock().expect("runs").remove(&id);
    if let Some(detail) = run.as_ref().and_then(|r| r.detail.as_ref()).filter(|_| error.is_some()) {
        counts["emailErrorDetail"] = json!({
            "status":detail["status"].as_i64(),
            "reason":detail["reason"].as_str().and_then(clean),
            "operation":detail["operation"].as_str().and_then(clean),
        });
    }
    let position = if p["savePosition"] == true { run.and_then(|r| r.anchor) } else { None };
    cx.db()
        .execute(
            "UPDATE app.connector_accounts SET last_sync_finished_at = now(), last_sync_status = $2,
               last_sync_error = $3, last_sync_counts = $4,
               email_history_id = COALESCE($5, email_history_id)
             WHERE id = $1 AND status <> 'revoked'",
            &[&id, &status, &error, &counts, &position],
        )
        .await?;
    Ok(json!({"saved":true}))
}

fn lost() -> Value {
    json!({"result":"lost"})
}

fn list_url(base: &Url, tail: &str, query: &[(&str, &str)]) -> Result<Url> {
    let mut url = Url::parse(&format!("{}/{}", base.as_str().trim_end_matches('/'), tail))?;
    url.query_pairs_mut().extend_pairs(query);
    Ok(url)
}

/// The page token for page `index` of a named list, or None when this run never reached it.
fn token_for(runs: &SyncRuns, id: Uuid, list: &str, index: usize) -> Option<Option<String>> {
    let all = runs.0.lock().expect("runs");
    let pages = all.get(&id)?.pages.get(list);
    match (pages, index) {
        (_, 0) => Some(None),
        (Some(pages), n) => pages.get(n).cloned(),
        _ => None,
    }
}

fn remember(runs: &SyncRuns, id: Uuid, list: &str, index: usize, next: Option<String>) {
    if let Some(run) = runs.0.lock().expect("runs").get_mut(&id) {
        let pages = run.pages.entry(list.into()).or_default();
        pages.resize(index + 2, None);
        pages[index + 1] = next;
    }
}

struct Slice {
    items: Vec<Value>,
    next: usize,
    done: bool,
}

/// The part of one page a chunk covers, and where the next chunk starts.
fn slice(items: &[Value], cursor: usize, limit: usize, more: bool) -> Slice {
    let offset = cursor % PAGE;
    let taken: Vec<Value> = items.iter().skip(offset).take(limit.max(1)).cloned().collect();
    let end = offset + taken.len() >= items.len();
    let next = if taken.is_empty() { cursor - offset + PAGE } else { cursor + taken.len() };
    Slice { items: taken, next, done: end && !more }
}

async fn calendar(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    runs: &SyncRuns,
    id: Uuid,
    p: &Value,
) -> Result<Fetched> {
    let (cursor, limit) = (p["cursor"].as_u64().unwrap_or(0) as usize, p["limit"].as_u64().unwrap_or(100) as usize);
    let Some(token) = token_for(runs, id, "calendar", cursor / PAGE) else { return Ok(Ok(lost())) };
    let started = runs.0.lock().expect("runs").get(&id).and_then(|r| r.started).unwrap_or_else(|| config.now());
    let (min, max) = (iso(started - Days::days(PAST_DAYS)), iso(started + Days::days(WINDOW_DAYS)));
    let max_results = PAGE.to_string();
    let mut query = vec![
        ("timeMin", min.as_str()), ("timeMax", max.as_str()), ("singleEvents", "true"),
        ("orderBy", "startTime"), ("maxResults", max_results.as_str()),
    ];
    if let Some(token) = token.as_deref() {
        query.push(("pageToken", token));
    }
    let url = list_url(config.calendar_base(), "calendars/primary/events", &query)?;
    let page = match call(cx, cipher, config, url, "calendar.events.list").await? {
        Ok(page) => page,
        Err(failure) => return Ok(Err(failure)),
    };
    let next_token = page["nextPageToken"].as_str().map(String::from);
    remember(runs, id, "calendar", cursor / PAGE, next_token.clone());
    let items = page["items"].as_array().cloned().unwrap_or_default();
    let part = slice(&items, cursor, limit, next_token.is_some());
    let events: Vec<Value> = part.items.iter().filter_map(calendar_event).collect();
    let skipped = part.items.len() - events.len();
    Ok(Ok(json!({"events":events,"skipped":skipped,"next":part.next,"done":part.done,"seenSince":iso(started)})))
}

fn gmail_query(phase: &str) -> Option<&'static str> {
    match phase {
        "email-day" => Some("newer_than:1d"),
        "email" => Some("newer_than:30d older_than:1d"),
        _ => None,
    }
}

async fn stored_position(cx: &DataContext, id: Uuid) -> Result<Option<String>> {
    Ok(cx
        .db()
        .query_one("SELECT email_history_id FROM app.connector_accounts WHERE id = $1", &[&id])
        .await?
        .get(0))
}

fn set_mode(runs: &SyncRuns, id: Uuid, mode: &str, anchor: Option<String>) {
    if let Some(run) = runs.0.lock().expect("runs").get_mut(&id) {
        run.mode = Some(mode.into());
        run.anchor = anchor;
        run.pages.remove("history");
        run.pages.remove("email");
    }
}

fn mode_of(runs: &SyncRuns, id: Uuid) -> Option<String> {
    runs.0.lock().expect("runs").get(&id).and_then(|r| r.mode.clone())
}

async fn list(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    runs: &SyncRuns,
    id: Uuid,
    p: &Value,
) -> Result<Fetched> {
    let phase = p["phase"].as_str().unwrap_or("");
    let Some(query) = gmail_query(phase) else { bail!("Unknown sync phase") };
    let (cursor, limit) = (p["cursor"].as_u64().unwrap_or(0) as usize, p["limit"].as_u64().unwrap_or(10) as usize);
    let backlog = phase == "email";
    if backlog && cursor == 0 && mode_of(runs, id).is_none() {
        let profile = list_url(config.gmail_base(), "users/me/profile", &[])?;
        let anchor = match call(cx, cipher, config, profile, "gmail.profile.get").await? {
            Ok(profile) => profile["historyId"].as_str().map(String::from),
            Err(failure) => return Ok(Err(failure)),
        };
        let mode = if anchor.is_some() && stored_position(cx, id).await?.is_some() { "history" } else { "full" };
        set_mode(runs, id, mode, anchor);
    }
    let history = backlog && mode_of(runs, id).as_deref() == Some("history");
    if backlog && mode_of(runs, id).is_none() {
        return Ok(Ok(lost()));
    }
    let name = if history { "history" } else { phase };
    let Some(token) = token_for(runs, id, name, cursor / PAGE) else { return Ok(Ok(lost())) };
    let max_results = PAGE.to_string();
    let (url, operation) = if history {
        let start = stored_position(cx, id).await?.unwrap_or_default();
        let mut q = vec![("startHistoryId", start.clone()), ("maxResults", max_results.clone())];
        q.extend(["messageAdded", "labelAdded", "labelRemoved"].map(|t| ("historyTypes", t.to_string())));
        if let Some(token) = &token {
            q.push(("pageToken", token.clone()));
        }
        let q: Vec<(&str, &str)> = q.iter().map(|(k, v)| (*k, v.as_str())).collect();
        (list_url(config.gmail_base(), "users/me/history", &q)?, "gmail.history.list")
    } else {
        let mut q = vec![("q", query), ("maxResults", max_results.as_str())];
        if let Some(token) = token.as_deref() {
            q.push(("pageToken", token));
        }
        (list_url(config.gmail_base(), "users/me/messages", &q)?, "gmail.messages.list")
    };
    let page = match call(cx, cipher, config, url, operation).await? {
        Ok(page) => page,
        Err(failure) if history && failure.status == Some(404) => {
            // The saved position is too old for Gmail, so the walk starts over in full.
            let anchor = runs.0.lock().expect("runs").get(&id).and_then(|r| r.anchor.clone());
            set_mode(runs, id, "full", anchor);
            return Ok(Ok(json!({"mode":"full","ids":[],"next":0,"done":false})));
        }
        Err(failure) => return Ok(Err(failure)),
    };
    let next_token = page["nextPageToken"].as_str().map(String::from);
    remember(runs, id, name, cursor / PAGE, next_token.clone());
    let ids: Vec<Value> = if history {
        let mut seen = Vec::<String>::new();
        for record in page["history"].as_array().into_iter().flatten() {
            for kind in ["messagesAdded", "labelsAdded", "labelsRemoved"] {
                for change in record[kind].as_array().into_iter().flatten() {
                    if let Some(id) = change["message"]["id"].as_str().filter(|id| !seen.iter().any(|s| s == id)) {
                        seen.push(id.into());
                    }
                }
            }
        }
        seen.into_iter().map(Value::from).collect()
    } else {
        page["messages"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).map(Value::from).collect()
    };
    let part = slice(&ids, cursor, limit, next_token.is_some());
    let mode = if history { "history" } else { "full" };
    Ok(Ok(json!({"mode":mode,"ids":part.items,"next":part.next,"done":part.done})))
}

async fn fetch(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    runs: &SyncRuns,
    id: Uuid,
    p: &Value,
) -> Result<Fetched> {
    let history = p["phase"] == "email" && mode_of(runs, id).as_deref() == Some("history");
    let oldest = (config.now() - Days::days(WINDOW_DAYS)).timestamp_millis();
    let (mut messages, mut failures, mut gone, mut stale) = (Vec::new(), 0, 0, 0);
    let mut error: Option<Value> = None;
    for item in p["ids"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let mut q = vec![("format", "metadata")];
        q.extend(["From", "To", "Cc", "Subject", "Message-ID", "References"].map(|h| ("metadataHeaders", h)));
        let url = list_url(config.gmail_base(), &format!("users/me/messages/{}", urlencode(item)), &q)?;
        match call(cx, cipher, config, url, "gmail.messages.get").await? {
            Ok(message) => match gmail_message(&message) {
                Some(parsed) if history && parsed["receivedMs"].as_i64().is_some_and(|ms| ms < oldest) => stale += 1,
                Some(parsed) => messages.push(parsed),
                None => failures += 1,
            },
            Err(failure) if failure.sign_in => return Ok(Err(failure)),
            Err(failure) if history && failure.status == Some(404) => gone += 1,
            Err(failure) => {
                failures += 1;
                error.get_or_insert(failure.answer()["error"].clone());
            }
        }
    }
    Ok(Ok(json!({"messages":messages,"failures":failures,"gone":gone,"stale":stale,"error":error})))
}

fn urlencode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_are_cleaned_and_capped() {
        assert_eq!(clean("rate Limit!!"), Some("rateLimit".into()));
        assert_eq!(clean(&"a".repeat(80)).unwrap().len(), 64);
        assert_eq!(clean("!!"), None);
    }

    #[test]
    fn reason_comes_from_errors_then_details_then_status() {
        let body = |v: Value| serde_json::to_vec(&v).unwrap();
        assert_eq!(reason_of(&body(json!({"error":{"errors":[{"reason":"rateLimitExceeded"}],"status":"X"}}))), Some("rateLimitExceeded".into()));
        assert_eq!(reason_of(&body(json!({"error":{"details":[{"reason":"BACKEND"}],"status":"X"}}))), Some("BACKEND".into()));
        assert_eq!(reason_of(&body(json!({"error":{"status":"UNAVAILABLE"}}))), Some("UNAVAILABLE".into()));
        assert_eq!(reason_of(b"not json"), None);
    }

    #[test]
    fn only_transient_refusals_retry() {
        assert!(retryable(429, &None) && retryable(503, &None) && retryable(408, &None));
        assert!(retryable(403, &Some("userRateLimitExceeded".into())));
        assert!(!retryable(404, &None) && !retryable(403, &Some("forbidden".into())));
    }

    #[test]
    fn chunks_walk_a_page_without_skipping_or_repeating() {
        let items: Vec<Value> = (0..25).map(Value::from).collect();
        let (mut cursor, mut seen) = (0, Vec::new());
        loop {
            let part = slice(&items, cursor, 10, false);
            seen.extend(part.items.iter().filter_map(Value::as_i64));
            cursor = part.next;
            if part.done {
                break;
            }
        }
        assert_eq!(seen, (0..25).collect::<Vec<i64>>());
    }

    #[test]
    fn a_page_with_more_to_come_is_not_done() {
        let items: Vec<Value> = (0..100).map(Value::from).collect();
        assert!(!slice(&items, 90, 10, true).done);
        assert_eq!(slice(&items, 90, 10, true).next, 100);
        assert!(slice(&items, 90, 10, false).done);
    }
}
