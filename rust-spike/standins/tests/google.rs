use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use moss_standins::{fixtures, google::*};
use serde_json::{json, Value};

const CODE_FORM: &[(&str, &str)] = &[
    ("grant_type", "authorization_code"),
    ("code", "4/0Afake-code"),
    ("client_id", "fake-client-id.apps.example.com"),
    ("client_secret", "fake-client-secret"),
    ("redirect_uri", "https://moss.example.com/oauth/callback"),
];

async fn server() -> (GoogleStandIn, reqwest::Client) {
    (GoogleStandIn::start(GoogleConfig::default()).await, reqwest::Client::new())
}

async fn post_form(c: &reqwest::Client, g: &GoogleStandIn, form: &[(&str, &str)]) -> (u16, Value) {
    let r = c.post(g.token_url()).form(form).send().await.unwrap();
    (r.status().as_u16(), r.json().await.unwrap())
}

/// Connects once and returns the access and refresh tokens.
async fn connect(c: &reqwest::Client, g: &GoogleStandIn) -> (String, String) {
    g.issue_code("4/0Afake-code");
    let (status, body) = post_form(c, g, CODE_FORM).await;
    assert_eq!(status, 200);
    (body["access_token"].as_str().unwrap().into(), body["refresh_token"].as_str().unwrap().into())
}

async fn get(c: &reqwest::Client, g: &GoogleStandIn, token: &str, path: &str) -> (u16, Value) {
    let r = c.get(format!("{}{path}", g.base_url())).bearer_auth(token).send().await.unwrap();
    (r.status().as_u16(), r.json().await.unwrap_or(Value::Null))
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

// ---- token endpoint ----

#[tokio::test]
async fn code_exchange_returns_the_real_token_shape_and_burns_the_code() {
    let (g, c) = server().await;
    g.issue_code("4/0Afake-code");
    let (status, body) = post_form(&c, &g, CODE_FORM).await;
    assert_eq!(status, 200);
    let shape: Value = serde_json::from_str(fixtures::TOKEN_AUTHORIZATION_CODE).unwrap();
    assert_eq!(keys(&body), keys(&shape));
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["expires_in"], 3599);
    // A code works once. Reuse is the real invalid_grant "Bad Request".
    let (status, body) = post_form(&c, &g, CODE_FORM).await;
    assert_eq!((status, body), (400, json!({"error": "invalid_grant", "error_description": "Bad Request"})));
}

#[tokio::test]
async fn refresh_returns_a_new_access_token_without_a_new_refresh_token() {
    let (g, c) = server().await;
    let (access, refresh) = connect(&c, &g).await;
    let form = [("grant_type", "refresh_token"), ("refresh_token", refresh.as_str()), ("client_id", "fake-client-id.apps.example.com"), ("client_secret", "fake-client-secret")];
    let (status, body) = post_form(&c, &g, &form).await;
    assert_eq!(status, 200);
    let shape: Value = serde_json::from_str(fixtures::TOKEN_REFRESH).unwrap();
    assert_eq!(keys(&body), keys(&shape));
    assert_ne!(body["access_token"], access.as_str());
}

#[tokio::test]
async fn revoked_refresh_token_returns_invalid_grant_revoked() {
    let (g, c) = server().await;
    let (_, refresh) = connect(&c, &g).await;
    g.revoke_refresh_token(&refresh);
    let form = [("grant_type", "refresh_token"), ("refresh_token", refresh.as_str()), ("client_id", "fake-client-id.apps.example.com"), ("client_secret", "fake-client-secret")];
    let (status, body) = post_form(&c, &g, &form).await;
    assert_eq!(status, 400);
    assert_eq!(body, json!({"error": "invalid_grant", "error_description": "Token has been expired or revoked."}));
}

#[tokio::test]
async fn wrong_client_secret_returns_invalid_client() {
    let (g, c) = server().await;
    g.issue_code("4/0Afake-code");
    let mut form = CODE_FORM.to_vec();
    form[3] = ("client_secret", "wrong");
    let r = c.post(g.token_url()).form(&form).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 401);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"], "invalid_client");
}

#[tokio::test]
async fn unknown_grant_type_is_unsupported() {
    let (g, c) = server().await;
    let form = [("grant_type", "password"), ("client_id", "fake-client-id.apps.example.com"), ("client_secret", "fake-client-secret")];
    let (status, body) = post_form(&c, &g, &form).await;
    assert_eq!((status, body["error"].as_str().unwrap()), (400, "unsupported_grant_type"));
}

// ---- guards ----

#[tokio::test]
async fn missing_or_expired_access_token_returns_the_real_401_body() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let (status, body) = get(&c, &g, "ya29.garbage", "/gmail/v1/users/me/profile").await;
    assert_eq!(status, 401);
    assert_eq!(body["error"]["status"], "UNAUTHENTICATED");
    assert_eq!(body["error"]["errors"][0]["reason"], "authError");
    g.expire_access_token(&access);
    let (status, _) = get(&c, &g, &access, "/gmail/v1/users/me/profile").await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn rate_limit_returns_429_with_retry_after_then_recovers() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    g.rate_limit_next(2);
    for _ in 0..2 {
        let r = c.get(format!("{}/gmail/v1/users/me/profile", g.base_url())).bearer_auth(&access).send().await.unwrap();
        assert_eq!(r.status().as_u16(), 429);
        assert_eq!(r.headers()["retry-after"], "7");
        let body: Value = r.json().await.unwrap();
        assert_eq!(body["error"]["status"], "RESOURCE_EXHAUSTED");
        assert_eq!(body["error"]["errors"][0]["reason"], "rateLimitExceeded");
    }
    assert_eq!(get(&c, &g, &access, "/gmail/v1/users/me/profile").await.0, 200);
}

// ---- Gmail ----

#[tokio::test]
async fn list_pages_newest_first_and_matches_the_real_shape() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let a = g.add_message(fixtures::MAIL_AGENDA, &["INBOX", "UNREAD"]);
    let b = g.add_message(fixtures::MAIL_LUNCH, &["INBOX"]);
    let d = g.add_message(fixtures::MAIL_INVOICE, &["INBOX"]);
    let (_, p1) = get(&c, &g, &access, "/gmail/v1/users/me/messages?maxResults=2").await;
    let shape: Value = serde_json::from_str(fixtures::GMAIL_MESSAGE_LIST).unwrap();
    assert_eq!(keys(&p1), keys(&shape));
    assert_eq!(keys(&p1["messages"][0]), keys(&shape["messages"][0]));
    assert_eq!(p1["messages"][0]["id"], d.as_str());
    assert_eq!(p1["messages"][1]["id"], b.as_str());
    let token = p1["nextPageToken"].as_str().unwrap();
    let (_, p2) = get(&c, &g, &access, &format!("/gmail/v1/users/me/messages?maxResults=2&pageToken={token}")).await;
    assert_eq!(p2["messages"][0]["id"], a.as_str());
    assert!(p2.get("nextPageToken").is_none());
}

#[tokio::test]
async fn empty_mailbox_list_has_no_messages_key_like_gmail() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let (_, body) = get(&c, &g, &access, "/gmail/v1/users/me/messages").await;
    assert_eq!(body, json!({"resultSizeEstimate": 0}));
}

#[tokio::test]
async fn message_get_full_matches_the_real_shape_and_decodes() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let id = g.add_message(fixtures::MAIL_AGENDA, &["INBOX", "UNREAD"]);
    let (status, m) = get(&c, &g, &access, &format!("/gmail/v1/users/me/messages/{id}?format=full")).await;
    assert_eq!(status, 200);
    let shape: Value = serde_json::from_str(fixtures::GMAIL_MESSAGE_FULL).unwrap();
    assert_eq!(keys(&m), keys(&shape));
    assert_eq!(keys(&m["payload"]), keys(&shape["payload"]));
    assert_eq!(keys(&m["payload"]["body"]), keys(&shape["payload"]["body"]));
    assert_eq!(m["payload"]["headers"][0].as_object().unwrap().keys().collect::<Vec<_>>(), shape["payload"]["headers"][0].as_object().unwrap().keys().collect::<Vec<_>>());
    // The recorded fixture's own body decodes to the same text the stand-in serves.
    let fixture_body = URL_SAFE_NO_PAD.decode(shape["payload"]["body"]["data"].as_str().unwrap()).unwrap();
    let served = URL_SAFE_NO_PAD.decode(m["payload"]["body"]["data"].as_str().unwrap()).unwrap();
    assert_eq!(String::from_utf8(fixture_body).unwrap().trim(), String::from_utf8(served).unwrap().trim());
    assert_eq!(m["labelIds"], json!(["INBOX", "UNREAD"]));
}

#[tokio::test]
async fn message_formats_and_multipart() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let id = g.add_message(fixtures::MAIL_LUNCH, &["INBOX"]);
    let (_, m) = get(&c, &g, &access, &format!("/gmail/v1/users/me/messages/{id}")).await;
    assert_eq!(m["payload"]["mimeType"], "multipart/alternative");
    assert_eq!(m["payload"]["parts"][0]["mimeType"], "text/plain");
    assert_eq!(m["payload"]["parts"][1]["mimeType"], "text/html");
    assert_eq!(m["snippet"], "Are you free for lunch on Friday?");
    let (_, min) = get(&c, &g, &access, &format!("/gmail/v1/users/me/messages/{id}?format=minimal")).await;
    assert!(min.get("payload").is_none());
    let (_, meta) = get(&c, &g, &access, &format!("/gmail/v1/users/me/messages/{id}?format=metadata")).await;
    assert!(meta["payload"].get("body").is_none() && meta["payload"]["headers"].is_array());
    let (_, raw) = get(&c, &g, &access, &format!("/gmail/v1/users/me/messages/{id}?format=raw")).await;
    let decoded = URL_SAFE_NO_PAD.decode(raw["raw"].as_str().unwrap()).unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), fixtures::MAIL_LUNCH);
}

#[tokio::test]
async fn unknown_message_returns_the_real_404() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let (status, body) = get(&c, &g, &access, "/gmail/v1/users/me/messages/nope").await;
    assert_eq!(status, 404);
    assert_eq!(body, serde_json::from_str::<Value>(fixtures::ERROR_404).unwrap());
}

#[tokio::test]
async fn history_reports_added_deleted_and_labelled_and_matches_the_real_shape() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let start = g.history_id();
    let id = g.add_message(fixtures::MAIL_AGENDA, &["INBOX", "UNREAD"]);
    let other = g.add_message(fixtures::MAIL_INVOICE, &["INBOX"]);
    g.add_label(&other, "STARRED");
    g.delete_message(&id);
    let (status, h) = get(&c, &g, &access, &format!("/gmail/v1/users/me/history?startHistoryId={start}")).await;
    assert_eq!(status, 200);
    let shape: Value = serde_json::from_str(fixtures::GMAIL_HISTORY).unwrap();
    assert_eq!(keys(&h), keys(&shape));
    assert_eq!(keys(&h["history"][0]), keys(&shape["history"][0]));
    let kinds: Vec<&str> = h["history"].as_array().unwrap().iter().map(|r| ["messagesAdded", "labelsAdded", "messagesDeleted"].into_iter().find(|k| r.get(*k).is_some()).unwrap()).collect();
    assert_eq!(kinds, ["messagesAdded", "messagesAdded", "labelsAdded", "messagesDeleted"]);
    assert_eq!(h["historyId"], g.history_id().to_string());
    // Nothing new since the latest id: Gmail returns only historyId.
    let now = g.history_id();
    let (_, h) = get(&c, &g, &access, &format!("/gmail/v1/users/me/history?startHistoryId={now}")).await;
    assert_eq!(h, json!({"historyId": now.to_string()}));
}

#[tokio::test]
async fn stale_history_start_returns_404_so_the_client_must_resync() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let start = g.history_id();
    g.add_message(fixtures::MAIL_AGENDA, &["INBOX"]);
    g.expire_history();
    let (status, body) = get(&c, &g, &access, &format!("/gmail/v1/users/me/history?startHistoryId={start}")).await;
    assert_eq!(status, 404);
    assert_eq!(body["error"]["status"], "NOT_FOUND");
}

#[tokio::test]
async fn send_records_the_message_and_returns_the_real_reply() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let id = g.add_message(fixtures::MAIL_AGENDA, &["INBOX"]);
    let raw = "To: alice@example.com\r\nSubject: Re: Thursday agenda\r\n\r\nSee you there.\r\n";
    let r = c.post(format!("{}/gmail/v1/users/me/messages/send", g.base_url())).bearer_auth(&access).json(&json!({"raw": URL_SAFE_NO_PAD.encode(raw), "threadId": id})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let body: Value = r.json().await.unwrap();
    let shape: Value = serde_json::from_str(fixtures::GMAIL_SEND_RESPONSE).unwrap();
    assert_eq!(keys(&body), keys(&shape));
    assert_eq!(body["labelIds"], json!(["SENT"]));
    assert_eq!(body["threadId"], id.as_str());
    assert_eq!(g.sent(), vec![raw.to_string()]);
}

#[tokio::test]
async fn send_with_a_bad_body_returns_400_invalid_argument() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let r = c.post(format!("{}/gmail/v1/users/me/messages/send", g.base_url())).bearer_auth(&access).json(&json!({"raw": "!!!not base64!!!"})).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 400);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"]["status"], "INVALID_ARGUMENT");
    assert!(g.sent().is_empty());
}

// ---- Calendar ----

#[tokio::test]
async fn calendar_list_matches_the_real_shape() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let (status, body) = get(&c, &g, &access, "/calendar/v3/users/me/calendarList").await;
    assert_eq!(status, 200);
    let shape: Value = serde_json::from_str(fixtures::CALENDAR_LIST).unwrap();
    assert_eq!(keys(&body), keys(&shape));
    assert_eq!(body["items"][0]["primary"], true);
}

#[tokio::test]
async fn calendar_event_insert_list_patch_delete_round_trip() {
    let (g, c) = server().await;
    let (access, _) = connect(&c, &g).await;
    let base = format!("{}/calendar/v3/calendars/primary/events", g.base_url());
    let new = json!({"summary": "Lunch", "start": {"dateTime": "2026-03-06T12:00:00Z"}, "end": {"dateTime": "2026-03-06T13:00:00Z"}});
    let ev: Value = c.post(&base).bearer_auth(&access).json(&new).send().await.unwrap().json().await.unwrap();
    let shape: Value = serde_json::from_str(fixtures::CALENDAR_EVENT).unwrap();
    assert_eq!(keys(&ev), keys(&shape));
    assert_eq!(ev["summary"], "Lunch");
    let id = ev["id"].as_str().unwrap().to_string();

    let (_, list) = get(&c, &g, &access, "/calendar/v3/calendars/primary/events").await;
    let list_shape: Value = serde_json::from_str(fixtures::CALENDAR_EVENTS_LIST).unwrap();
    assert_eq!(keys(&list), keys(&list_shape));
    assert_eq!(list["items"].as_array().unwrap().len(), 1);

    let moved: Value = c.patch(format!("{base}/{id}")).bearer_auth(&access).json(&json!({"start": {"dateTime": "2026-03-06T14:00:00Z"}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(moved["start"]["dateTime"], "2026-03-06T14:00:00Z");
    assert_eq!(moved["sequence"], 1);

    let r = c.delete(format!("{base}/{id}")).bearer_auth(&access).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 204);
    assert!(g.events().is_empty());
    // A second delete is the real 410 "Resource has been deleted".
    let r = c.delete(format!("{base}/{id}")).bearer_auth(&access).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 410);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"]["errors"][0]["reason"], "deleted");
    // An id that never existed is 404.
    let r = c.delete(format!("{base}/never")).bearer_auth(&access).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 404);
}

// ---- fixtures ----

#[tokio::test]
async fn every_error_fixture_has_the_shape_google_uses() {
    for body in [fixtures::ERROR_401, fixtures::ERROR_429, fixtures::ERROR_404, fixtures::ERROR_410_DELETED, fixtures::ERROR_400_INVALID_RAW] {
        let v: Value = serde_json::from_str(body).unwrap();
        assert!(v["error"]["code"].is_u64() && v["error"]["message"].is_string() && v["error"]["errors"][0]["reason"].is_string(), "{body}");
    }
    for body in [fixtures::ERROR_TOKEN_REVOKED, fixtures::ERROR_TOKEN_BAD_CODE, fixtures::ERROR_TOKEN_BAD_CLIENT] {
        let v: Value = serde_json::from_str(body).unwrap();
        assert!(v["error"].is_string() && v["error_description"].is_string(), "{body}");
    }
}

/// A guard for the personal-data review: every address and host in the fixtures is invented.
#[test]
fn fixtures_hold_only_example_addresses() {
    let all = [
        fixtures::TOKEN_AUTHORIZATION_CODE, fixtures::TOKEN_REFRESH, fixtures::GMAIL_MESSAGE_FULL, fixtures::GMAIL_MESSAGE_LIST,
        fixtures::GMAIL_HISTORY, fixtures::GMAIL_SEND_RESPONSE, fixtures::CALENDAR_EVENT, fixtures::CALENDAR_EVENTS_LIST,
        fixtures::CALENDAR_LIST, fixtures::MAIL_AGENDA, fixtures::MAIL_LUNCH, fixtures::MAIL_INVOICE, fixtures::ERROR_401,
    ];
    for text in all {
        for (at, _) in text.match_indices('@') {
            let domain: String = text[at + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
            let domain = domain.trim_end_matches('.');
            assert!(domain == "example.com" || domain.ends_with(".example.com") || domain == "google.com", "unexpected domain {domain:?}");
        }
        assert!(!text.contains("gmail.com") && !text.contains("outlook.com"), "real mail domain in fixture");
    }
}
