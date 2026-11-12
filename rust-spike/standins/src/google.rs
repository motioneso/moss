//! A fake Google: OAuth token endpoint, Gmail and Calendar, served over plain HTTP on loopback.
//!
//! Point the code under test at `base_url()` instead of Google's hosts. Error bodies come
//! from the fixtures and match what Google sends.

use crate::fixtures::{self as fx, fill};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{Arc, Mutex},
};

pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: String,
    pub email: String,
}

impl Default for GoogleConfig {
    fn default() -> Self {
        Self {
            client_id: "fake-client-id.apps.example.com".into(),
            client_secret: "fake-client-secret".into(),
            email: "bob@example.com".into(),
        }
    }
}

struct GMessage {
    id: String,
    thread_id: String,
    labels: Vec<String>,
    raw: String,
    internal_ms: u64,
}

enum Change {
    Added(String),
    Deleted(String),
    LabelsAdded(String, Vec<String>),
}

struct State_ {
    cfg: GoogleConfig,
    codes: HashSet<String>,
    refresh_tokens: HashMap<String, bool>, // token -> revoked
    access_tokens: HashMap<String, bool>,  // token -> valid
    counter: u64,
    messages: Vec<GMessage>,
    changes: Vec<(u64, Change)>,
    history_id: u64,
    oldest_history_id: u64,
    sent: Vec<String>,
    events: Vec<Value>,
    deleted_events: HashSet<String>,
    rate_limit_left: u32,
    requests: Vec<String>,
}

type Shared = Arc<Mutex<State_>>;

pub struct GoogleStandIn {
    pub addr: SocketAddr,
    state: Shared,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for GoogleStandIn {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl GoogleStandIn {
    pub async fn start(cfg: GoogleConfig) -> Self {
        let state: Shared = Arc::new(Mutex::new(State_ {
            cfg,
            codes: HashSet::new(),
            refresh_tokens: HashMap::new(),
            access_tokens: HashMap::new(),
            counter: 0,
            messages: vec![],
            changes: vec![],
            history_id: 4821,
            oldest_history_id: 4821,
            sent: vec![],
            events: vec![],
            deleted_events: HashSet::new(),
            rate_limit_left: 0,
            requests: vec![],
        }));
        let app = Router::new()
            .route("/token", post(token))
            .route("/gmail/v1/users/me/profile", get(profile))
            .route("/gmail/v1/users/me/messages", get(list_messages))
            .route("/gmail/v1/users/me/messages/send", post(send))
            .route("/gmail/v1/users/me/messages/{id}", get(get_message))
            .route("/gmail/v1/users/me/history", get(history))
            .route("/calendar/v3/users/me/calendarList", get(calendar_list))
            .route("/calendar/v3/calendars/{cal}/events", get(list_events).post(insert_event))
            .route("/calendar/v3/calendars/{cal}/events/{id}", delete(delete_event).patch(patch_event))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind google");
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { addr, state, task }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn token_url(&self) -> String {
        format!("{}/token", self.base_url())
    }

    fn with<R>(&self, f: impl FnOnce(&mut State_) -> R) -> R {
        f(&mut self.state.lock().unwrap())
    }

    /// Registers an authorization code that the token endpoint will accept once.
    pub fn issue_code(&self, code: &str) {
        self.with(|s| {
            s.codes.insert(code.into());
        })
    }

    /// Makes a refresh token answer like a revoked grant.
    pub fn revoke_refresh_token(&self, token: &str) {
        self.with(|s| {
            s.refresh_tokens.insert(token.into(), true);
        })
    }

    /// Makes an access token answer 401, as after expiry.
    pub fn expire_access_token(&self, token: &str) {
        self.with(|s| {
            s.access_tokens.insert(token.into(), false);
        })
    }

    /// Makes the next `n` API calls answer 429 with a Retry-After header.
    pub fn rate_limit_next(&self, n: u32) {
        self.with(|s| s.rate_limit_left = n)
    }

    /// Adds a message (raw RFC 822 text) to the mailbox and returns its Gmail id.
    pub fn add_message(&self, raw: &str, labels: &[&str]) -> String {
        self.with(|s| {
            s.counter += 1;
            let id = format!("18c3f2a1b4d5e{:03x}", 0x6f7 + s.counter);
            let labels: Vec<String> = labels.iter().map(|l| l.to_string()).collect();
            s.history_id += 1;
            let hid = s.history_id;
            s.changes.push((hid, Change::Added(id.clone())));
            s.messages.push(GMessage {
                id: id.clone(),
                thread_id: id.clone(),
                labels,
                raw: raw.into(),
                internal_ms: 1_772_442_900_000 + s.counter * 60_000,
            });
            id
        })
    }

    pub fn delete_message(&self, id: &str) {
        self.with(|s| {
            s.messages.retain(|m| m.id != id);
            s.history_id += 1;
            let hid = s.history_id;
            s.changes.push((hid, Change::Deleted(id.into())));
        })
    }

    pub fn add_label(&self, id: &str, label: &str) {
        self.with(|s| {
            if let Some(m) = s.messages.iter_mut().find(|m| m.id == id) {
                m.labels.push(label.into());
            }
            s.history_id += 1;
            let hid = s.history_id;
            s.changes.push((hid, Change::LabelsAdded(id.into(), vec![label.into()])));
        })
    }

    /// Makes history older than the current point answer 404, like Google after about a week.
    pub fn expire_history(&self) {
        self.with(|s| s.oldest_history_id = s.history_id + 1)
    }

    pub fn history_id(&self) -> u64 {
        self.with(|s| s.history_id)
    }

    /// Messages sent through the send endpoint, as decoded RFC 822 text.
    pub fn sent(&self) -> Vec<String> {
        self.with(|s| s.sent.clone())
    }

    /// Adds a calendar event directly, as if made in Google's own calendar.
    pub fn add_event(&self, summary: &str, start: &str, end: &str) -> String {
        self.with(|s| {
            s.counter += 1;
            let mut ev: Value = serde_json::from_str(fx::CALENDAR_EVENT).unwrap();
            let id = format!("fakeevent{:04}", s.counter);
            ev["id"] = json!(id);
            ev["iCalUID"] = json!(format!("{id}@google.com"));
            ev["creator"]["email"] = json!(s.cfg.email);
            ev["organizer"]["email"] = json!(s.cfg.email);
            ev["summary"] = json!(summary);
            ev["start"] = json!({"dateTime":start});
            ev["end"] = json!({"dateTime":end});
            s.events.push(ev);
            id
        })
    }

    /// Removes the first event with this title, as if deleted in Google's own calendar.
    pub fn remove_event_titled(&self, summary: &str) {
        self.with(|s| {
            if let Some(at) = s.events.iter().position(|e| e["summary"] == summary) {
                let id = s.events[at]["id"].as_str().unwrap_or("").to_string();
                s.events.remove(at);
                s.deleted_events.insert(id);
            }
        })
    }

    pub fn events(&self) -> Vec<Value> {
        self.with(|s| s.events.clone())
    }

    /// "METHOD /path" for every API call, including refused ones.
    pub fn requests(&self) -> Vec<String> {
        self.with(|s| s.requests.clone())
    }
}

fn json_response(status: u16, body: String) -> Response {
    (StatusCode::from_u16(status).unwrap(), [(header::CONTENT_TYPE, "application/json; charset=UTF-8")], body).into_response()
}

fn api_error(status: u16, body: &str, extra: &[(&'static str, &str)]) -> Response {
    let mut r = json_response(status, body.to_string());
    for (k, v) in extra {
        r.headers_mut().insert(*k, v.parse().unwrap());
    }
    r
}

/// Applies the rate limit and the bearer check shared by every API route.
fn guard(st: &Shared, method: &str, path: &str, headers: &HeaderMap) -> Result<(), Response> {
    let mut s = st.lock().unwrap();
    s.requests.push(format!("{method} {path}"));
    if s.rate_limit_left > 0 {
        s.rate_limit_left -= 1;
        return Err(api_error(429, fx::ERROR_429, &[("retry-after", "7")]));
    }
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    match token {
        Some(t) if s.access_tokens.get(t) == Some(&true) => Ok(()),
        _ => Err(api_error(401, fx::ERROR_401, &[("www-authenticate", "Bearer realm=\"https://accounts.google.com/\", error=invalid_token")])),
    }
}

macro_rules! guarded {
    ($st:expr, $m:expr, $p:expr, $h:expr) => {
        if let Err(r) = guard(&$st, $m, $p, &$h) {
            return r;
        }
    };
}

// ---- OAuth token endpoint ----

async fn token(State(st): State<Shared>, body: Bytes) -> Response {
    let form: HashMap<String, String> = String::from_utf8_lossy(&body)
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (url_decode(k), url_decode(v)))
        .collect();
    let mut s = st.lock().unwrap();
    let get = |k: &str| form.get(k).cloned().unwrap_or_default();
    if get("client_id") != s.cfg.client_id || get("client_secret") != s.cfg.client_secret {
        return api_error(401, fx::ERROR_TOKEN_BAD_CLIENT, &[("www-authenticate", "Bearer realm=\"https://accounts.google.com/\"")]);
    }
    match get("grant_type").as_str() {
        "authorization_code" => {
            if !s.codes.remove(&get("code")) {
                return json_response(400, fx::ERROR_TOKEN_BAD_CODE.into());
            }
            s.counter += 1;
            let (access, refresh) = (format!("ya29.fake-access-{}", s.counter), format!("1//fake-refresh-{}", s.counter));
            s.access_tokens.insert(access.clone(), true);
            s.refresh_tokens.insert(refresh.clone(), false);
            json_response(200, fill(fx::TOKEN_AUTHORIZATION_CODE, &[("ACCESS_TOKEN", &access), ("REFRESH_TOKEN", &refresh)]))
        }
        "refresh_token" => match s.refresh_tokens.get(&get("refresh_token")) {
            Some(false) => {
                s.counter += 1;
                let access = format!("ya29.fake-access-{}", s.counter);
                s.access_tokens.insert(access.clone(), true);
                json_response(200, fill(fx::TOKEN_REFRESH, &[("ACCESS_TOKEN", &access)]))
            }
            Some(true) => json_response(400, fx::ERROR_TOKEN_REVOKED.into()),
            None => json_response(400, fx::ERROR_TOKEN_BAD_CODE.into()),
        },
        other => json_response(400, fill(fx::ERROR_UNSUPPORTED_GRANT, &[("GRANT_TYPE", other)])),
    }
}

fn url_decode(s: &str) -> String {
    let b = s.replace('+', " ").into_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---- Gmail ----

async fn profile(State(st): State<Shared>, h: HeaderMap) -> Response {
    guarded!(st, "GET", "/gmail/v1/users/me/profile", h);
    let s = st.lock().unwrap();
    json_response(
        200,
        json!({"emailAddress": s.cfg.email, "messagesTotal": s.messages.len(), "threadsTotal": s.messages.len(), "historyId": s.history_id.to_string()}).to_string(),
    )
}

async fn list_messages(State(st): State<Shared>, h: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    guarded!(st, "GET", "/gmail/v1/users/me/messages", h);
    let s = st.lock().unwrap();
    let max: usize = q.get("maxResults").and_then(|v| v.parse().ok()).unwrap_or(100);
    let start: usize = q.get("pageToken").and_then(|v| v.parse().ok()).unwrap_or(0);
    let label = q.get("labelIds");
    // Newest first, like Gmail.
    let all: Vec<&GMessage> = s.messages.iter().rev().filter(|m| label.is_none_or(|l| m.labels.contains(l))).collect();
    let page: Vec<Value> = all.iter().skip(start).take(max).map(|m| json!({"id": m.id, "threadId": m.thread_id})).collect();
    let mut body = json!({"resultSizeEstimate": all.len()});
    if !page.is_empty() {
        body["messages"] = Value::Array(page);
    }
    if start + max < all.len() {
        body["nextPageToken"] = json!((start + max).to_string());
    }
    json_response(200, body.to_string())
}

async fn get_message(State(st): State<Shared>, h: HeaderMap, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    guarded!(st, "GET", "/gmail/v1/users/me/messages/{id}", h);
    let s = st.lock().unwrap();
    let Some(m) = s.messages.iter().find(|m| m.id == id) else {
        return json_response(404, fx::ERROR_404.into());
    };
    let format = q.get("format").map(String::as_str).unwrap_or("full");
    json_response(200, message_json(m, format, s.history_id).to_string())
}

fn message_json(m: &GMessage, format: &str, history_id: u64) -> Value {
    let (head, body) = m.raw.split_once("\r\n\r\n").unwrap_or((m.raw.as_str(), ""));
    let mut headers: Vec<(String, String)> = Vec::new();
    for l in head.split("\r\n") {
        if l.starts_with([' ', '\t']) {
            if let Some(last) = headers.last_mut() {
                last.1 += &format!(" {}", l.trim());
            }
        } else if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().into(), v.trim().into()));
        }
    }
    let ctype = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.clone()).unwrap_or_else(|| "text/plain".into());
    let header_json: Vec<Value> = headers.iter().map(|(k, v)| json!({"name": k, "value": v})).collect();
    let text_body = if ctype.starts_with("multipart/") { first_text_part(&ctype, body) } else { body.to_string() };
    let snippet: String = text_body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect();
    let mut out = json!({
        "id": m.id, "threadId": m.thread_id, "labelIds": m.labels,
        "snippet": snippet, "sizeEstimate": m.raw.len(),
        "historyId": history_id.to_string(), "internalDate": m.internal_ms.to_string(),
    });
    match format {
        "minimal" => {}
        "raw" => out["raw"] = json!(URL_SAFE_NO_PAD.encode(&m.raw)),
        "metadata" => {
            out["payload"] = json!({"partId": "", "mimeType": mime_of(&ctype), "filename": "", "headers": header_json});
        }
        _ => {
            let mut payload = json!({"partId": "", "mimeType": mime_of(&ctype), "filename": "", "headers": header_json});
            if ctype.starts_with("multipart/") {
                let parts: Vec<Value> = split_parts(&ctype, body)
                    .iter()
                    .enumerate()
                    .map(|(i, (pt, pb))| {
                        json!({"partId": i.to_string(), "mimeType": mime_of(pt), "filename": "",
                          "headers": [{"name": "Content-Type", "value": pt}],
                          "body": {"size": pb.len(), "data": URL_SAFE_NO_PAD.encode(pb)}})
                    })
                    .collect();
                payload["body"] = json!({"size": 0});
                payload["parts"] = Value::Array(parts);
            } else {
                payload["body"] = json!({"size": body.len(), "data": URL_SAFE_NO_PAD.encode(body)});
            }
            out["payload"] = payload;
        }
    }
    out
}

fn mime_of(content_type: &str) -> String {
    content_type.split(';').next().unwrap_or("text/plain").trim().to_string()
}

fn split_parts(ctype: &str, body: &str) -> Vec<(String, String)> {
    let Some(boundary) = ctype.split("boundary=").nth(1).map(|b| b.trim_matches(['"', ' ', ';'])) else { return vec![] };
    let marker = format!("--{boundary}");
    body.split(&marker)
        .skip(1)
        .filter(|p| !p.starts_with("--"))
        .filter_map(|p| {
            let p = p.trim_start_matches("\r\n");
            let (ph, pb) = p.split_once("\r\n\r\n")?;
            let ct = ph.lines().find_map(|l| l.strip_prefix("Content-Type: "))?.to_string();
            Some((ct, pb.trim_end_matches("\r\n").to_string()))
        })
        .collect()
}

fn first_text_part(ctype: &str, body: &str) -> String {
    split_parts(ctype, body).into_iter().find(|(c, _)| c.starts_with("text/plain")).map(|(_, b)| b).unwrap_or_default()
}

async fn history(State(st): State<Shared>, h: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    guarded!(st, "GET", "/gmail/v1/users/me/history", h);
    let s = st.lock().unwrap();
    let Some(start) = q.get("startHistoryId").and_then(|v| v.parse::<u64>().ok()) else {
        return api_error(400, fx::ERROR_400_INVALID_RAW, &[]);
    };
    if start < s.oldest_history_id {
        return json_response(404, fx::ERROR_404.into());
    }
    let mut records: Vec<Value> = Vec::new();
    for (hid, change) in s.changes.iter().filter(|(hid, _)| *hid > start) {
        let msg_ref = |id: &str| {
            let labels = s.messages.iter().find(|m| m.id == id).map(|m| m.labels.clone()).unwrap_or_default();
            json!({"id": id, "threadId": id, "labelIds": labels})
        };
        let rec = match change {
            Change::Added(id) => json!({"id": hid.to_string(), "messages": [{"id": id, "threadId": id}], "messagesAdded": [{"message": msg_ref(id)}]}),
            Change::Deleted(id) => json!({"id": hid.to_string(), "messages": [{"id": id, "threadId": id}], "messagesDeleted": [{"message": {"id": id, "threadId": id}}]}),
            Change::LabelsAdded(id, l) => json!({"id": hid.to_string(), "messages": [{"id": id, "threadId": id}], "labelsAdded": [{"message": msg_ref(id), "labelIds": l}]}),
        };
        records.push(rec);
    }
    let mut body = json!({"historyId": s.history_id.to_string()});
    if !records.is_empty() {
        body["history"] = Value::Array(records);
    }
    json_response(200, body.to_string())
}

async fn send(State(st): State<Shared>, h: HeaderMap, body: Bytes) -> Response {
    guarded!(st, "POST", "/gmail/v1/users/me/messages/send", h);
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    let raw = parsed
        .as_ref()
        .and_then(|v| v.get("raw")?.as_str())
        .and_then(|r| URL_SAFE_NO_PAD.decode(r.trim_end_matches('=')).ok().or_else(|| STANDARD.decode(r).ok()))
        .and_then(|b| String::from_utf8(b).ok());
    let Some(raw) = raw else {
        return json_response(400, fx::ERROR_400_INVALID_RAW.into());
    };
    let thread = parsed.as_ref().and_then(|v| v.get("threadId")?.as_str().map(String::from));
    let mut s = st.lock().unwrap();
    s.counter += 1;
    let id = format!("18c3f2a1b4d5e{:03x}", 0x6f7 + s.counter);
    let thread = thread.unwrap_or_else(|| id.clone());
    s.history_id += 1;
    let hid = s.history_id;
    s.changes.push((hid, Change::Added(id.clone())));
    let internal_ms = 1_772_442_900_000 + s.counter * 60_000;
    s.messages.push(GMessage { id: id.clone(), thread_id: thread.clone(), labels: vec!["SENT".into()], raw: raw.clone(), internal_ms });
    s.sent.push(raw);
    json_response(200, json!({"id": id, "threadId": thread, "labelIds": ["SENT"]}).to_string())
}

// ---- Calendar ----

async fn calendar_list(State(st): State<Shared>, h: HeaderMap) -> Response {
    guarded!(st, "GET", "/calendar/v3/users/me/calendarList", h);
    let email = st.lock().unwrap().cfg.email.clone();
    json_response(200, fx::CALENDAR_LIST.replace("bob@example.com", &email))
}

async fn list_events(State(st): State<Shared>, h: HeaderMap, Path(_cal): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    guarded!(st, "GET", "/calendar/v3/calendars/{cal}/events", h);
    let s = st.lock().unwrap();
    let max: usize = q.get("maxResults").and_then(|v| v.parse().ok()).unwrap_or(250);
    let start: usize = q.get("pageToken").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body: Value = serde_json::from_str(fx::CALENDAR_EVENTS_LIST).unwrap();
    body["summary"] = json!(s.cfg.email);
    let page: Vec<Value> = s.events.iter().skip(start).take(max).cloned().collect();
    body["items"] = Value::Array(page);
    if start + max < s.events.len() {
        body["nextPageToken"] = json!((start + max).to_string());
        body.as_object_mut().unwrap().remove("nextSyncToken");
    }
    json_response(200, body.to_string())
}

async fn insert_event(State(st): State<Shared>, h: HeaderMap, Path(_cal): Path<String>, body: Bytes) -> Response {
    guarded!(st, "POST", "/calendar/v3/calendars/{cal}/events", h);
    let Ok(input) = serde_json::from_slice::<Value>(&body) else {
        return json_response(400, fx::ERROR_400_INVALID_RAW.into());
    };
    let mut s = st.lock().unwrap();
    s.counter += 1;
    let mut ev: Value = serde_json::from_str(fx::CALENDAR_EVENT).unwrap();
    let id = format!("fakeevent{:04}", s.counter);
    ev["id"] = json!(id);
    ev["iCalUID"] = json!(format!("{id}@google.com"));
    ev["htmlLink"] = json!(format!("https://www.google.com/calendar/event?eid={}", URL_SAFE_NO_PAD.encode(&id)));
    ev["creator"]["email"] = json!(s.cfg.email);
    ev["organizer"]["email"] = json!(s.cfg.email);
    for (k, v) in input.as_object().cloned().unwrap_or_default() {
        ev[k] = v;
    }
    s.events.push(ev.clone());
    json_response(200, ev.to_string())
}

async fn patch_event(State(st): State<Shared>, h: HeaderMap, Path((_cal, id)): Path<(String, String)>, body: Bytes) -> Response {
    guarded!(st, "PATCH", "/calendar/v3/calendars/{cal}/events/{id}", h);
    let mut s = st.lock().unwrap();
    if s.deleted_events.contains(&id) {
        return json_response(410, fx::ERROR_410_DELETED.into());
    }
    let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(ev) = s.events.iter_mut().find(|e| e["id"] == id.as_str()) else {
        return json_response(404, fx::ERROR_404.into());
    };
    for (k, v) in input.as_object().cloned().unwrap_or_default() {
        ev[k] = v;
    }
    let seq = ev["sequence"].as_i64().unwrap_or(0) + 1;
    ev["sequence"] = json!(seq);
    json_response(200, ev.to_string())
}

async fn delete_event(State(st): State<Shared>, h: HeaderMap, Path((_cal, id)): Path<(String, String)>) -> Response {
    guarded!(st, "DELETE", "/calendar/v3/calendars/{cal}/events/{id}", h);
    let mut s = st.lock().unwrap();
    if s.deleted_events.contains(&id) {
        return json_response(410, fx::ERROR_410_DELETED.into());
    }
    let before = s.events.len();
    s.events.retain(|e| e["id"] != id.as_str());
    if s.events.len() == before {
        return json_response(404, fx::ERROR_404.into());
    }
    s.deleted_events.insert(id);
    StatusCode::NO_CONTENT.into_response()
}
