//! Google connect in the host. It builds the consent address, keeps the pending sign-in,
//! swaps the pasted code for tokens, seals the secrets and refreshes tokens near expiry.
//! The client secret and tokens stay here. Nothing in an answer to the package carries them.
use crate::store;
use anyhow::{anyhow, bail, ensure, Result};
use chrono::{DateTime, Utc};
use moss_module_host::network::{Network, Outbound, Response, Transport};
use moss_module_host::runtime::Request;
use portability::secrets::JsonSecretCipher;
use reqwest::{header::HeaderMap, Method};
use safety_core::db::DataContext;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;

pub const PROVIDER: &str = "google";
pub const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
pub const GMAIL_BASE: &str = "https://gmail.googleapis.com/gmail/v1";
pub const CALENDAR_BASE: &str = "https://www.googleapis.com/calendar/v3";
pub const LOOPBACK_REDIRECT: &str = "http://localhost:1";
pub const SCOPES: [&str; 2] = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
];
/// Tokens with more than this left are used as they are.
const FRESH_FOR: i64 = 60;
const HTTP_LIMIT: Duration = Duration::from_secs(10);
const COMPLETE_MAX: usize = 5;
const COMPLETE_WINDOW: Duration = Duration::from_secs(60);

/// Where token requests go and how. Production sends to Google over approved https only.
/// A test-only setting points it at a stand-in server.
pub struct GoogleConfig {
    transport: Arc<dyn Transport>,
    token_url: Url,
    hosts: BTreeSet<String>,
    allow_private: bool,
    gmail_base: Url,
    calendar_base: Url,
    api_hosts: BTreeSet<String>,
    retry_delay: Duration,
    now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    attempts: Mutex<HashMap<Uuid, VecDeque<Instant>>>,
}

impl GoogleConfig {
    pub fn production() -> Self {
        let url = Url::parse(TOKEN_ENDPOINT).expect("fixed address");
        Self::with_transport(Arc::new(Network), url, false)
    }

    /// Token requests to a stand-in Google on this machine, over plain http. This exists only
    /// for tests and the test-only setting, and it refuses any address that is not loopback.
    pub fn test_only_loopback(token_url: &str) -> Result<Self> {
        let url = Url::parse(token_url).map_err(|_| anyhow!("The test-only Google address is not a URL"))?;
        let loopback = match url.host() {
            Some(url::Host::Domain(name)) => name == "localhost",
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
        ensure!(url.scheme() == "http" && loopback, "The test-only Google address must be http on this machine");
        let mut config = Self::with_transport(Arc::new(PlainHttp), url.clone(), true);
        let origin = url.origin().ascii_serialization();
        config.gmail_base = Url::parse(&format!("{origin}/gmail/v1")).expect("loopback origin");
        config.calendar_base = Url::parse(&format!("{origin}/calendar/v3")).expect("loopback origin");
        config.api_hosts = url.host_str().map(String::from).into_iter().collect();
        Ok(config)
    }

    /// A transport that may reach any address, for a stand-in Google. Never used in a normal install.
    pub fn with_transport(transport: Arc<dyn Transport>, token_url: Url, allow_private: bool) -> Self {
        let hosts = token_url.host_str().map(String::from).into_iter().collect();
        Self {
            transport,
            token_url,
            hosts,
            allow_private,
            gmail_base: Url::parse(GMAIL_BASE).expect("fixed address"),
            calendar_base: Url::parse(CALENDAR_BASE).expect("fixed address"),
            api_hosts: ["gmail.googleapis.com", "www.googleapis.com"].map(String::from).into(),
            retry_delay: Duration::from_millis(250),
            now: Arc::new(Utc::now),
            attempts: Mutex::default(),
        }
    }

    pub(crate) fn gmail_base(&self) -> &Url {
        &self.gmail_base
    }

    pub(crate) fn calendar_base(&self) -> &Url {
        &self.calendar_base
    }

    pub(crate) fn retry_delay(&self) -> Duration {
        self.retry_delay
    }

    /// The wait before a retried Google read, times the attempt number. Tests shorten it.
    pub fn with_retry_delay(mut self, delay: Duration) -> Self {
        self.retry_delay = delay;
        self
    }

    pub(crate) fn now(&self) -> DateTime<Utc> {
        (self.now)()
    }

    /// A read from the Gmail or Calendar API. The outer error is a transport failure. The
    /// answer is the status and the body. Nothing here records the token or the body.
    pub(crate) async fn get(&self, url: Url, token: &str) -> Result<(u16, Vec<u8>)> {
        self.request(Method::GET, url, token, None, HTTP_LIMIT).await
    }

    /// A write to the Gmail or Calendar API. It is sent once and never retried, because a
    /// repeated send would send twice. `limit` bounds the HTTP call itself, so the request
    /// cannot finish after the caller has already reported a failure.
    pub(crate) async fn request(
        &self,
        method: Method,
        url: Url,
        token: &str,
        body: Option<Value>,
        limit: Duration,
    ) -> Result<(u16, Vec<u8>)> {
        let transport = Arc::clone(&self.transport);
        let (hosts, allow_private) = (self.api_hosts.clone(), self.allow_private);
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {token}").parse().map_err(|_| anyhow!("Unusable access token"))?,
        );
        let response = tokio::task::spawn_blocking(move || {
            transport.send(Outbound {
                url: &url,
                hosts: &hosts,
                allow_private,
                method,
                headers,
                body,
                timeout: limit.min(HTTP_LIMIT),
            })
        })
        .await
        .map_err(|_| anyhow!("The Google request did not finish"))??;
        Ok((response.status, response.body))
    }

    pub fn with_clock(mut self, now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>) -> Self {
        self.now = now;
        self
    }

    /// At most five completions per person per minute, as on the old server.
    fn allow_complete(&self, actor: Uuid) -> bool {
        let mut all = self.attempts.lock().expect("limiter");
        let queue = all.entry(actor).or_default();
        let now = Instant::now();
        while queue.front().is_some_and(|t| now.duration_since(*t) >= COMPLETE_WINDOW) {
            queue.pop_front();
        }
        if queue.len() >= COMPLETE_MAX {
            return false;
        }
        queue.push_back(now);
        true
    }
}

/// The answer to a refresh request that did not give a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshFailure {
    NoConnection,
    /// Google refused the stored sign-in. The account now reads as needing sign-in.
    NeedsSignIn,
    /// The request itself failed. The stored sign-in is untouched.
    Unreachable,
}

pub async fn run(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    request: &Request,
) -> Result<Value> {
    let p = &request.parameters;
    match (request.operation.as_str(), request.resource.as_str()) {
        ("set", "connectors.google-authorize") => authorize(cx, cipher, p).await,
        ("set", "connectors.google-complete") => complete(cx, cipher, config, p).await,
        _ => bail!("Unknown connectors resource"),
    }
}

/// The consent address, with the same parameters in the same order as the old server.
pub fn build_auth_url(client_id: &str, state: &str) -> Url {
    let mut url = Url::parse(AUTH_ENDPOINT).expect("fixed address");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", LOOPBACK_REDIRECT)
        .append_pair("response_type", "code")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("include_granted_scopes", "true")
        .append_pair("state", state)
        .append_pair("scope", &SCOPES.join(" "));
    url
}

/// Pulls the code and state out of the pasted address. A failure here was a plain error in
/// the old server, so it answers 500 with the generic text.
pub fn parse_redirect(pasted: &str) -> Result<(String, String)> {
    let url = Url::parse(pasted.trim()).map_err(|_| anyhow!("Pasted redirect URL is not a valid URL"))?;
    let get = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
            .filter(|v| !v.is_empty())
    };
    if let Some(error) = get("error") {
        bail!("Google returned an authorization error: {error}");
    }
    match (get("code"), get("state")) {
        (Some(code), Some(state)) => Ok((code, state)),
        _ => bail!("Redirect URL is missing the code or state parameter"),
    }
}

async fn authorize(cx: &DataContext, cipher: &JsonSecretCipher, p: &Value) -> Result<Value> {
    let client_id = store::text(p, "clientId")?;
    let client_secret = store::text(p, "clientSecret")?;
    let state = Uuid::new_v4().to_string();
    let sealed = store::seal(cipher, &json!({"clientId":client_id,"clientSecret":client_secret}))?;
    cx.db()
        .execute("DELETE FROM app.connector_oauth_pending WHERE provider_id = $1", &[&PROVIDER])
        .await?;
    cx.db()
        .execute(
            "INSERT INTO app.connector_oauth_pending
               (id, owner_user_id, provider_id, state, encrypted_secret, created_at)
             VALUES ($1, app.current_actor_user_id(), $2, $3, $4, now())",
            &[&Uuid::new_v4(), &PROVIDER, &state, &sealed],
        )
        .await?;
    Ok(json!({"authUrl":build_auth_url(client_id, &state).to_string()}))
}

fn failure(message: &str) -> Value {
    json!({"failure":message})
}

async fn complete(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    p: &Value,
) -> Result<Value> {
    if !config.allow_complete(cx.actor_user_id()) {
        return Ok(json!({"refused":{"status":429,"body":{
            "statusCode":429,"error":"Too Many Requests",
            "message":"Rate limit exceeded, retry in 1 minute"}}}));
    }
    let (code, state) = parse_redirect(store::text(p, "redirectUrl")?)?;
    let pending = cx
        .db()
        .query_opt(
            "SELECT state, encrypted_secret FROM app.connector_oauth_pending WHERE provider_id = $1",
            &[&PROVIDER],
        )
        .await?;
    let Some(pending) = pending else {
        return Ok(failure("No pending Google authorization found \u{2014} start the connect flow again"));
    };
    if pending.get::<_, String>(0) != state {
        return Ok(failure("Authorization state did not match \u{2014} please retry the connect flow"));
    }
    let credentials = open(cipher, &pending.get::<_, Value>(1))?;
    let client_id = string(&credentials, "clientId")?;
    let client_secret = string(&credentials, "clientSecret")?;
    let tokens = post_token(
        config,
        &[
            ("code", code.as_str()),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
            ("redirect_uri", LOOPBACK_REDIRECT),
            ("grant_type", "authorization_code"),
        ],
    )
    .await?
    .map_err(|status| anyhow!("Google token endpoint returned {status}"))?;
    let Some(refresh) = tokens.refresh_token else {
        return Ok(failure("Google did not return a refresh token \u{2014} re-consent with prompt=consent"));
    };
    let granted: Vec<String> = match &tokens.scope {
        Some(scope) if !scope.is_empty() => scope.split(' ').map(String::from).collect(),
        _ => SCOPES.iter().map(|s| s.to_string()).collect(),
    };
    let bundle = json!({
        "kind":"google-oauth","clientId":client_id,"clientSecret":client_secret,
        "accessToken":tokens.access_token,"refreshToken":refresh,
        "tokenExpiry":expiry(config, tokens.expires_in),"grantedScopes":granted,
    });
    let existing = cx
        .db()
        .query_opt("SELECT id FROM app.connector_accounts WHERE provider_id = $1", &[&PROVIDER])
        .await?;
    let account = match existing {
        Some(row) => {
            let id: Uuid = row.get(0);
            store::update(
                cx,
                cipher,
                &json!({"id":id.to_string(),"scopes":granted,"status":"active","tokenPayload":bundle}),
            )
            .await?
        }
        None => {
            store::create(
                cx,
                cipher,
                &json!({"providerId":PROVIDER,"scopes":granted,"status":"active","tokenPayload":bundle}),
            )
            .await?
        }
    };
    cx.db()
        .execute("DELETE FROM app.connector_oauth_pending WHERE provider_id = $1", &[&PROVIDER])
        .await?;
    Ok(json!({"account":account}))
}

/// A token for the signed-in person's active Google account, refreshed when under a minute
/// is left or when `force` is set. Syncing uses this. It never reaches the package.
pub async fn fresh_access_token(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    force: bool,
) -> Result<std::result::Result<String, RefreshFailure>> {
    Ok(fresh_access_token_traced(cx, cipher, config, force).await?.0)
}

/// Same as `fresh_access_token`, and also says whether Google was asked. Callers that
/// waited behind a real refresh share its answer, including a failure.
pub async fn fresh_access_token_traced(
    cx: &DataContext,
    cipher: &JsonSecretCipher,
    config: &GoogleConfig,
    force: bool,
) -> Result<(std::result::Result<String, RefreshFailure>, bool)> {
    let row = cx
        .db()
        .query_opt(
            "SELECT id, encrypted_secret FROM app.connector_accounts
             WHERE provider_id = $1 AND status = 'active'",
            &[&PROVIDER],
        )
        .await?;
    let Some(row) = row else {
        return Ok((Err(RefreshFailure::NoConnection), false));
    };
    let id: Uuid = row.get(0);
    let original: Value = row.get(1);
    let mut bundle = open(cipher, &original)?;
    let left = DateTime::parse_from_rfc3339(&string(&bundle, "tokenExpiry")?)
        .map(|t| t.timestamp_millis() - (config.now)().timestamp_millis())
        .unwrap_or(0);
    if !force && left > FRESH_FOR * 1000 {
        return Ok((Ok(string(&bundle, "accessToken")?), false));
    }
    let refreshed = post_token(
        config,
        &[
            ("client_id", &string(&bundle, "clientId")?),
            ("client_secret", &string(&bundle, "clientSecret")?),
            ("refresh_token", &string(&bundle, "refreshToken")?),
            ("grant_type", "refresh_token"),
        ],
    )
    .await;
    // The person may have reconnected or disconnected while Google answered. Lock the row and
    // use that newer state instead of writing over it with a response to the old sign-in.
    let current = cx
        .db()
        .query_opt(
            "SELECT encrypted_secret FROM app.connector_accounts
             WHERE id = $1 AND status = 'active' FOR UPDATE",
            &[&id],
        )
        .await?;
    match current {
        None => return Ok((Err(RefreshFailure::NoConnection), true)),
        Some(row) if row.get::<_, Value>(0) != original => {
            let newer = open(cipher, &row.get::<_, Value>(0))?;
            return Ok((Ok(string(&newer, "accessToken")?), true));
        }
        Some(_) => {}
    }
    let tokens = match refreshed {
        Ok(Ok(tokens)) => tokens,
        Ok(Err(400 | 401 | 403)) => {
            mark_needs_sign_in(cx, id).await?;
            return Ok((Err(RefreshFailure::NeedsSignIn), true));
        }
        _ => return Ok((Err(RefreshFailure::Unreachable), true)),
    };
    bundle.insert("accessToken".into(), json!(tokens.access_token));
    bundle.insert("tokenExpiry".into(), json!(expiry(config, tokens.expires_in)));
    if let Some(next) = tokens.refresh_token {
        bundle.insert("refreshToken".into(), json!(next));
    }
    let token = tokens.access_token;
    store::update(
        cx,
        cipher,
        &json!({"id":id.to_string(),"tokenPayload":Value::Object(bundle)}),
    )
    .await?;
    Ok((Ok(token), true))
}

/// Records the same failed run with the same label the old sync wrote when sign-in failed.
async fn mark_needs_sign_in(cx: &DataContext, id: Uuid) -> Result<()> {
    let counts = json!({"calendarUpserted":0,"calendarReconciled":0,"emailUpserted":0,
        "emailFailures":0,"escalations":0,"truncated":false});
    cx.db()
        .execute(
            "UPDATE app.connector_accounts SET last_sync_finished_at = now(), updated_at = now(),
               last_sync_status = 'failed', last_sync_error = 'auth-error', last_sync_counts = $2
             WHERE id = $1",
            &[&id, &counts],
        )
        .await?;
    Ok(())
}

fn open(cipher: &JsonSecretCipher, envelope: &Value) -> Result<Map<String, Value>> {
    let parsed = cipher
        .parse_envelope(envelope)
        .map_err(|_| anyhow!("The stored Google sign-in cannot be read"))?;
    Ok(cipher
        .decrypt_json(&parsed)
        .map_err(|_| anyhow!("The stored Google sign-in cannot be read"))?
        .value)
}

fn string(map: &Map<String, Value>, name: &str) -> Result<String> {
    map.get(name)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| anyhow!("The stored Google sign-in is incomplete"))
}

fn expiry(config: &GoogleConfig, seconds: i64) -> String {
    ((config.now)() + chrono::Duration::seconds(seconds))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

struct Tokens {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
    scope: Option<String>,
}

/// Posts a token request off the async thread. The outer error is a transport failure,
/// the inner error is the status Google answered. No body or secret goes into an error.
async fn post_token(
    config: &GoogleConfig,
    form: &[(&str, &str)],
) -> Result<std::result::Result<Tokens, u16>> {
    let body: Map<String, Value> = form.iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
    let transport = Arc::clone(&config.transport);
    let (url, hosts, allow_private) = (config.token_url.clone(), config.hosts.clone(), config.allow_private);
    let response = tokio::task::spawn_blocking(move || {
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded".parse().expect("header"),
        );
        transport.send(Outbound {
            url: &url,
            hosts: &hosts,
            allow_private,
            method: Method::POST,
            headers,
            body: Some(Value::Object(body)),
            timeout: HTTP_LIMIT,
        })
    })
    .await
    .map_err(|_| anyhow!("The Google request did not finish"))??;
    if !(200..300).contains(&response.status) {
        return Ok(Err(response.status));
    }
    let value: Value = serde_json::from_slice(&response.body)
        .map_err(|_| anyhow!("Google sent an unreadable token answer"))?;
    let access_token = value["access_token"].as_str().map(String::from);
    ensure!(access_token.is_some(), "Google sent no access token");
    Ok(Ok(Tokens {
        access_token: access_token.unwrap_or_default(),
        expires_in: value["expires_in"].as_i64().unwrap_or(3600),
        refresh_token: value["refresh_token"].as_str().map(String::from),
        scope: value["scope"].as_str().map(String::from),
    }))
}

/// Plain http to a local stand-in. Reached only through `GoogleConfig::test_only_loopback`.
struct PlainHttp;
impl Transport for PlainHttp {
    fn send(&self, r: Outbound<'_>) -> Result<Response> {
        let form = r
            .headers
            .get(reqwest::header::CONTENT_TYPE)
            .is_some_and(|h| h == "application/x-www-form-urlencoded");
        let mut request = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(r.timeout)
            .build()?
            .request(r.method, r.url.clone())
            .headers(r.headers);
        if let Some(body) = &r.body {
            if form {
                let fields: Vec<(String, String)> = body
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                    .collect();
                request = request.form(&fields);
            } else {
                request = request.json(body);
            }
        }
        let response = request
            .send()
            .map_err(|_| anyhow!("The remote service request failed"))?;
        let status = response.status().as_u16();
        Ok(Response { status, body: response.bytes()?.to_vec() })
    }
}
