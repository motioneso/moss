//! Sign-in, sessions and who each request belongs to.
//!
//! This is better-auth's email and password flow on the same tables, cookie and password hashes,
//! so a session made by either server works on the other. The auth role reads and writes users,
//! credential accounts and sessions. Everything a signed-in user does runs in a [`DataContext`]
//! on the app role, so row-level security applies to admins too. Session tokens, cookies and
//! passwords never reach a log line or an error body.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::{AUTHORIZATION, COOKIE, SET_COOKIE, USER_AGENT};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use portability::password::{hash_password, verify_password};
use portability::secrets::{resolve_moss_env, Env};
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio_postgres::{Client, Row};
use uuid::Uuid;

use crate::access::AccessContext;
use crate::db::{DataContext, Database, RuntimeRole};
use crate::error::{json_reply, ApiError};
use crate::http::{log, Platform};
use crate::secret::Secret;

pub const SESSION_COOKIE: &str = "better-auth.session_token";
const SECURE_SESSION_COOKIE: &str = "__Secure-better-auth.session_token";
const SESSION_SECONDS: i64 = 7 * 24 * 60 * 60;
const REFRESH_AFTER_SECONDS: i64 = 24 * 60 * 60;
const TEST_AUTH_SECRET: &str = "jarv1s-test-better-auth-secret";
const MIN_PASSWORD: usize = 8;
const MAX_PASSWORD: usize = 128;

/// The settings sign-up may read before anyone is signed in.
const PREAUTH_SETTINGS: [&str; 2] = ["registration.enabled", "registration.requires_approval"];

/// The columns of `app.get_user_by_id` that [`serialize_user`] reads.
pub const USER_FIELDS: &str = "id, email, email_verified, name, is_instance_admin, status, \
                               is_bootstrap_owner, created_at, updated_at";

const AUTH_USER_FIELDS: &str =
    "id, email, name, email_verified, image, is_instance_admin, created_at, updated_at";

/// Signs and reads the session cookie.
pub struct SessionCookies {
    secret: Secret,
    secure: bool,
}

impl SessionCookies {
    /// `readAuthSecret` and `useSecureCookies` from `createBetterAuthOptions`.
    pub fn from_env(env: &Env) -> Result<Self, String> {
        Ok(Self { secret: auth_secret(env)?, secure: trust_proxy(env)? })
    }

    pub fn name(&self) -> &'static str {
        if self.secure {
            SECURE_SESSION_COOKIE
        } else {
            SESSION_COOKIE
        }
    }

    fn sign(&self, token: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.secret.expose_secret().as_bytes())
            .expect("HMAC takes a key of any length");
        mac.update(token.as_bytes());
        STANDARD.encode(mac.finalize().into_bytes())
    }

    fn attributes(&self) -> &'static str {
        if self.secure {
            "Path=/; HttpOnly; SameSite=Lax; Secure"
        } else {
            "Path=/; HttpOnly; SameSite=Lax"
        }
    }

    fn set_cookie(&self, token: &str) -> String {
        let value = encode_uri_component(&format!("{token}.{}", self.sign(token)));
        format!("{}={value}; Max-Age={SESSION_SECONDS}; {}", self.name(), self.attributes())
    }

    fn clear_cookie(&self) -> String {
        format!("{}=; Max-Age=0; {}", self.name(), self.attributes())
    }

    /// The session token from a validly signed cookie.
    pub fn read_token(&self, headers: &HeaderMap) -> Option<String> {
        let raw = cookie_value(headers, self.name())?;
        let decoded = decode_uri_component(raw)?;
        let (token, signature) = decoded.rsplit_once('.')?;
        if signature.len() != 44 || !signature.ends_with('=') {
            return None;
        }
        let valid: bool = self.sign(token).as_bytes().ct_eq(signature.as_bytes()).into();
        valid.then(|| token.to_owned())
    }
}

fn auth_secret(env: &Env) -> Result<Secret, String> {
    // `BETTER_AUTH_SECRET ?? AUTH_SECRET`: an empty first value does not fall through.
    let named = env.get("BETTER_AUTH_SECRET").or_else(|| env.get("AUTH_SECRET"));
    if let Some(secret) = named.filter(|secret| !secret.is_empty()) {
        return Ok(Secret::new(secret.as_str()));
    }
    let var = |name: &str| env.get(name).map(String::as_str);
    if var("VITEST") == Some("true") || var("NODE_ENV") == Some("test") {
        return Ok(Secret::new(TEST_AUTH_SECRET));
    }
    if var("NODE_ENV") == Some("production") {
        return Err("BETTER_AUTH_SECRET is required in production".into());
    }
    log(json!({
        "level": "warn",
        "event": "auth_ephemeral_secret",
        "msg": "BETTER_AUTH_SECRET is not set; sessions end when this process restarts"
    }));
    let bytes: [u8; 32] = rand::random();
    Ok(Secret::new(bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

/// `resolveTrustProxy(...) !== false`: secure cookies behind a trusted proxy.
fn trust_proxy(env: &Env) -> Result<bool, String> {
    let value = resolve_moss_env(env, "JARVIS_TRUST_PROXY").unwrap_or_default().trim();
    if value.is_empty() {
        return Ok(false);
    }
    if value.eq_ignore_ascii_case("loopback") {
        return Ok(true);
    }
    if value.split(',').all(|address| address.trim().parse::<std::net::IpAddr>().is_ok()) {
        return Ok(true);
    }
    Err("JARVIS_TRUST_PROXY must be unset, \"loopback\", or a comma-separated list of exact IP \
         addresses"
        .into())
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// JavaScript's `decodeURIComponent`; malformed input gives `None`.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `authorization.split(/\s+/, 2)` with a case-insensitive `bearer` scheme.
pub fn read_bearer_token(headers: &HeaderMap) -> Option<String> {
    let header = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let mut pieces = js_split_whitespace(header).into_iter();
    let scheme = pieces.next()?;
    let token = pieces.next()?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_owned())
}

/// JavaScript's `split(/\s+/)`: a leading run yields an empty first piece.
fn js_split_whitespace(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut in_space = false;
    for (index, ch) in text.char_indices() {
        if ch.is_whitespace() {
            if !in_space {
                pieces.push(&text[start..index]);
                in_space = true;
            }
        } else if in_space {
            start = index;
            in_space = false;
        }
    }
    if !in_space {
        pieces.push(&text[start..]);
    }
    pieces
}

/// The `isUuid` shape check: hyphenated, any case.
pub fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// zod's `z.email()` pattern, which better-auth checks emails against.
fn is_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    let local_ok = !local.starts_with('.')
        && !local.contains("..")
        && local.chars().all(|ch| ch.is_ascii_alphanumeric() || "_'+-.".contains(ch))
        && local.chars().last().is_some_and(|ch| ch.is_ascii_alphanumeric() || "_+-".contains(ch));
    let labels: Vec<&str> = domain.split('.').collect();
    let Some((top, rest)) = labels.split_last() else {
        return false;
    };
    let label_ok = |label: &&str| {
        label.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric())
            && label.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    };
    local_ok
        && !rest.is_empty()
        && rest.iter().all(label_ok)
        && top.len() >= 2
        && top.chars().all(|ch| ch.is_ascii_alphabetic())
}

fn new_session_token() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect()
}

fn fingerprint(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>()[..12].to_owned()
}

pub fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `serializeUser`, from a row with [`USER_FIELDS`].
pub fn serialize_user(row: &Row) -> Value {
    json!({
        "id": row.get::<_, Uuid>("id"),
        "email": row.get::<_, String>("email"),
        "emailVerified": row.get::<_, bool>("email_verified"),
        "name": row.get::<_, String>("name"),
        "isInstanceAdmin": row.get::<_, bool>("is_instance_admin"),
        "status": row.get::<_, String>("status"),
        "isBootstrapOwner": row.get::<_, bool>("is_bootstrap_owner"),
        "createdAt": iso(row.get("created_at")),
        "updatedAt": iso(row.get("updated_at")),
    })
}

/// A better-auth error reply, `{code, message}`, or an internal error.
pub enum Failure {
    Reply { status: u16, code: &'static str, message: &'static str },
    Internal(ApiError),
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Failure::Internal(error)
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Failure::Reply { status, code, message } => {
                json_reply(status, &json!({ "code": code, "message": message }))
            }
            Failure::Internal(error) => error.into_response(),
        }
    }
}

pub(crate) fn fail(status: u16, code: &'static str, message: &'static str) -> Failure {
    Failure::Reply { status, code, message }
}

fn registration_disabled() -> Failure {
    fail(403, "registration_disabled", "Registration is disabled")
}

fn invalid_credentials() -> Failure {
    fail(401, "INVALID_EMAIL_OR_PASSWORD", "Invalid email or password")
}

/// A user as better-auth returns it.
struct AuthUser {
    id: Uuid,
    email: String,
    name: String,
    email_verified: bool,
    image: Option<String>,
    is_instance_admin: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl AuthUser {
    fn from_row(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            email: row.get("email"),
            name: row.get("name"),
            email_verified: row.get("email_verified"),
            image: row.get("image"),
            is_instance_admin: row.get("is_instance_admin"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        }
    }

    fn output(&self) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "image": self.image,
            "emailVerified": self.email_verified,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "isInstanceAdmin": self.is_instance_admin,
        })
    }
}

/// A connection on the auth role, the only role that may touch users, accounts and sessions.
async fn auth_client(auth: &Database) -> Result<deadpool_postgres::Object, ApiError> {
    if auth.role() != RuntimeRole::Auth {
        return Err(ApiError::Internal("sign-in tables need the auth role".into()));
    }
    auth.client().await
}

async fn user_by_email(auth: &Database, email: &str) -> Result<Option<AuthUser>, ApiError> {
    let client = auth_client(auth).await?;
    let sql = format!("SELECT {AUTH_USER_FIELDS} FROM app.users WHERE email = $1");
    Ok(client.query_opt(&sql, &[&email]).await?.as_ref().map(AuthUser::from_row))
}

async fn insert_user(
    auth: &Database,
    name: &str,
    email: &str,
    image: Option<&str>,
) -> Result<AuthUser, ApiError> {
    let client = auth_client(auth).await?;
    let sql = format!(
        "INSERT INTO app.users \
           (id, name, email, email_verified, image, created_at, updated_at, is_instance_admin) \
         VALUES ($1, $2, $3, false, $4, $5, $5, false) RETURNING {AUTH_USER_FIELDS}"
    );
    let row = client.query_one(&sql, &[&Uuid::new_v4(), &name, &email, &image, &Utc::now()]).await?;
    Ok(AuthUser::from_row(&row))
}

async fn delete_user(auth: &Database, user_id: Uuid) -> Result<(), ApiError> {
    let client = auth_client(auth).await?;
    client.execute("DELETE FROM app.users WHERE id = $1", &[&user_id]).await?;
    Ok(())
}

async fn insert_credential(auth: &Database, user_id: Uuid, hash: &str) -> Result<(), ApiError> {
    let client = auth_client(auth).await?;
    client
        .execute(
            "INSERT INTO app.auth_accounts \
               (id, account_id, provider_id, user_id, password, created_at, updated_at) \
             VALUES ($1, $2, 'credential', $3, $4, $5, $5)",
            &[&Uuid::new_v4(), &user_id.to_string(), &user_id, &hash, &Utc::now()],
        )
        .await?;
    Ok(())
}

async fn credential_hash(auth: &Database, user_id: Uuid) -> Result<Option<String>, ApiError> {
    let client = auth_client(auth).await?;
    let row = client
        .query_opt(
            "SELECT password FROM app.auth_accounts \
             WHERE user_id = $1 AND provider_id = 'credential' LIMIT 1",
            &[&user_id],
        )
        .await?;
    Ok(row.and_then(|row| row.get::<_, Option<String>>(0)))
}

async fn create_session(
    auth: &Database,
    user_id: Uuid,
    headers: &HeaderMap,
) -> Result<String, ApiError> {
    let token = new_session_token();
    let now = Utc::now();
    let user_agent = headers.get(USER_AGENT).and_then(|value| value.to_str().ok());
    let client = auth_client(auth).await?;
    client
        .execute(
            "INSERT INTO app.better_auth_sessions \
               (id, token, expires_at, created_at, updated_at, ip_address, user_agent, user_id) \
             VALUES ($1, $2, $3, $4, $4, NULL, $5, $6)",
            &[
                &Uuid::new_v4(),
                &token,
                &(now + Duration::seconds(SESSION_SECONDS)),
                &now,
                &user_agent,
                &user_id,
            ],
        )
        .await?;
    Ok(token)
}

/// The user behind a session token. Expired sessions are deleted; sessions older than a day
/// get a fresh week, as `getSession` does.
async fn session_user(auth: &Database, token: &str) -> Result<Option<Uuid>, ApiError> {
    let client = auth_client(auth).await?;
    let Some(row) = client
        .query_opt(
            "SELECT id, user_id, expires_at FROM app.better_auth_sessions WHERE token = $1",
            &[&token],
        )
        .await?
    else {
        return Ok(None);
    };
    let (id, user_id, expires_at): (Uuid, Uuid, DateTime<Utc>) =
        (row.get(0), row.get(1), row.get(2));
    let now = Utc::now();
    if expires_at < now {
        client.execute("DELETE FROM app.better_auth_sessions WHERE id = $1", &[&id]).await?;
        return Ok(None);
    }
    let refresh_at =
        expires_at - Duration::seconds(SESSION_SECONDS) + Duration::seconds(REFRESH_AFTER_SECONDS);
    if refresh_at <= now {
        client
            .execute(
                "UPDATE app.better_auth_sessions SET expires_at = $2, updated_at = $3 WHERE id = $1",
                &[&id, &(now + Duration::seconds(SESSION_SECONDS)), &now],
            )
            .await?;
    }
    Ok(Some(user_id))
}

async fn delete_session(auth: &Database, token: &str) -> Result<(), ApiError> {
    let client = auth_client(auth).await?;
    client.execute("DELETE FROM app.better_auth_sessions WHERE token = $1", &[&token]).await?;
    Ok(())
}

async fn bootstrap_owner_exists(db: &Client) -> Result<bool, ApiError> {
    let row = db
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM app.list_all_users() WHERE is_bootstrap_owner = true)",
            &[],
        )
        .await?;
    Ok(row.get(0))
}

/// `readBooleanSetting` for the settings sign-up may read; both default to on.
async fn read_flag(db: &Client, key: &'static str) -> Result<bool, ApiError> {
    if !PREAUTH_SETTINGS.contains(&key) {
        return Err(ApiError::Internal(format!("pre-auth read not allowed for {key}")));
    }
    let row =
        db.query_opt("SELECT value FROM app.instance_settings WHERE key = $1", &[&key]).await?;
    let value = row.map(|row| row.get::<_, Value>(0));
    Ok(value.and_then(|value| value.get("value").and_then(Value::as_bool)).unwrap_or(true))
}

/// `registrationGate`: once an owner exists, sign-up follows `registration.enabled`. It runs on
/// the app role with no actor, reading only owner existence and the pre-auth settings.
async fn registration_gate(platform: &Platform) -> Result<(), Failure> {
    let client = platform.app.client().await?;
    if bootstrap_owner_exists(&client).await? && !read_flag(&client, "registration.enabled").await?
    {
        return Err(registration_disabled());
    }
    Ok(())
}

/// `bootstrapFirstMossUser`: the first user becomes the owner and admin; later users are
/// pending when the instance requires approval. Runs as the new user, under a lock, so two
/// first sign-ups cannot both become the owner.
async fn bootstrap(platform: &Platform, user: &AuthUser) -> Result<(), Failure> {
    let request_id = format!("bootstrap:{}", user.id);
    let cx = DataContext::open(&platform.app, &AccessContext::new(user.id, request_id.clone()))
        .await?;
    let db = cx.db();
    db.execute("SELECT pg_advisory_xact_lock(hashtext('jarv1s:first-user-bootstrap'))", &[])
        .await
        .map_err(ApiError::from)?;
    let owner = !bootstrap_owner_exists(db).await?;
    let status = if owner {
        "active"
    } else if !read_flag(db, "registration.enabled").await? {
        return Err(registration_disabled());
    } else if read_flag(db, "registration.requires_approval").await? {
        "pending"
    } else {
        "active"
    };
    db.execute(
        "UPDATE app.users SET name = $2, email = $3, is_instance_admin = $4, \
           is_bootstrap_owner = $4, status = $5, updated_at = now() \
         WHERE id = $1",
        &[&user.id, &user.name, &user.email, &owner, &status],
    )
    .await
    .map_err(ApiError::from)?;
    if owner {
        db.execute(
            "SELECT app.record_bootstrap_owner_audit_event($1::uuid, $2::uuid, $3)",
            &[&user.id, &user.id, &request_id],
        )
        .await
        .map_err(ApiError::from)?;
    }
    cx.commit().await?;
    Ok(())
}

fn parse_body(body: &Bytes) -> Option<Value> {
    serde_json::from_slice::<Value>(body).ok().filter(Value::is_object)
}

fn text<'a>(body: &'a Value, name: &str) -> Option<&'a str> {
    body.get(name).and_then(Value::as_str)
}

async fn hash_in_background(password: Secret) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_password(password.expose_secret()))
        .await
        .map_err(|_| ApiError::Internal("password hashing stopped".into()))
}

fn with_cookie(mut response: Response, cookie: &str) -> Result<Response, ApiError> {
    let value = HeaderValue::from_str(cookie)
        .map_err(|_| ApiError::Internal("session cookie is not a header value".into()))?;
    response.headers_mut().append(SET_COOKIE, value);
    Ok(response)
}

/// `POST /api/auth/sign-up/email`.
async fn sign_up(
    State(platform): State<Arc<Platform>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Failure> {
    platform.origins.check_auth_post(&headers)?;
    let body = parse_body(&body).ok_or(fail(400, "VALIDATION_ERROR", "Invalid body"))?;
    let (Some(email), Some(password), Some(name)) =
        (text(&body, "email"), text(&body, "password"), text(&body, "name"))
    else {
        return Err(fail(400, "VALIDATION_ERROR", "Invalid body"));
    };
    let email = email.to_lowercase();
    if !is_email(&email) {
        return Err(fail(400, "INVALID_EMAIL", "Invalid email"));
    }
    platform.origins.check_sign_in_form(&headers)?;
    let length = password.encode_utf16().count();
    if length < MIN_PASSWORD {
        return Err(fail(400, "PASSWORD_TOO_SHORT", "Password too short"));
    }
    if length > MAX_PASSWORD {
        return Err(fail(400, "PASSWORD_TOO_LONG", "Password too long"));
    }
    if user_by_email(&platform.auth, &email).await?.is_some() {
        return Err(fail(
            422,
            "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
            "User already exists. Use another email.",
        ));
    }
    // `isInstanceAdmin` is `input: false` with a default, so better-auth drops a client value
    // on create. The insert below always writes false; only the bootstrap may set it.
    let hash = hash_in_background(Secret::new(password)).await?;
    registration_gate(&platform).await?;

    let user = insert_user(&platform.auth, name, &email, text(&body, "image"))
        .await
        .map_err(|_| fail(422, "FAILED_TO_CREATE_USER", "Failed to create user"))?;
    if let Err(failure) = bootstrap(&platform, &user).await {
        delete_user(&platform.auth, user.id).await?;
        return Err(match failure {
            Failure::Internal(error) => {
                log(json!({
                    "level": "error",
                    "event": "auth.bootstrap_failed",
                    "msg": format!("{error:?}"),
                }));
                fail(422, "FAILED_TO_CREATE_USER", "Failed to create user")
            }
            reply => reply,
        });
    }
    insert_credential(&platform.auth, user.id, &hash).await?;
    let token = create_session(&platform.auth, user.id, &headers).await?;
    let reply = json_reply(200, &json!({ "token": token, "user": user.output() }));
    Ok(with_cookie(reply, &platform.sessions.set_cookie(&token))?)
}

/// `POST /api/auth/sign-in/email`.
async fn sign_in(
    State(platform): State<Arc<Platform>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Failure> {
    platform.origins.check_auth_post(&headers)?;
    let body = parse_body(&body).ok_or(fail(400, "VALIDATION_ERROR", "Invalid body"))?;
    let (Some(email), Some(password)) = (text(&body, "email"), text(&body, "password")) else {
        return Err(fail(400, "VALIDATION_ERROR", "Invalid body"));
    };
    platform.origins.check_sign_in_form(&headers)?;
    let email = email.to_lowercase();
    if !is_email(&email) {
        return Err(fail(400, "INVALID_EMAIL", "Invalid email"));
    }
    let password = Secret::new(password);
    let user = user_by_email(&platform.auth, &email).await?;
    let hash = match &user {
        Some(user) => credential_hash(&platform.auth, user.id).await?,
        None => None,
    };
    let (Some(user), Some(hash)) = (user, hash) else {
        // Hash anyway so a missing account takes as long as a wrong password.
        hash_in_background(password).await?;
        return Err(invalid_credentials());
    };
    let matched = tokio::task::spawn_blocking(move || {
        verify_password(&hash, password.expose_secret()).unwrap_or(false)
    })
    .await
    .map_err(|_| ApiError::Internal("password check stopped".into()))?;
    if !matched {
        return Err(invalid_credentials());
    }
    let token = create_session(&platform.auth, user.id, &headers).await?;
    let reply =
        json_reply(200, &json!({ "redirect": false, "token": token, "user": user.output() }));
    Ok(with_cookie(reply, &platform.sessions.set_cookie(&token))?)
}

/// `POST /api/auth/sign-out`.
async fn sign_out(
    State(platform): State<Arc<Platform>>,
    headers: HeaderMap,
) -> Result<Response, Failure> {
    platform.origins.check_auth_post(&headers)?;
    let cleared = platform.sessions.clear_cookie();
    let Some(token) = platform.sessions.read_token(&headers) else {
        let reply = fail(400, "FAILED_TO_GET_SESSION", "Failed to get session").into_response();
        return Ok(with_cookie(reply, &cleared)?);
    };
    delete_session(&platform.auth, &token).await?;
    Ok(with_cookie(json_reply(200, &json!({ "success": true })), &cleared)?)
}

/// `resolveRequestAccessContext`: the legacy session bearer first, then the session cookie,
/// then the account state. Pending and deactivated accounts are refused on every request.
pub async fn resolve_access(
    platform: &Platform,
    headers: &HeaderMap,
) -> Result<AccessContext, ApiError> {
    let request_id = Uuid::new_v4().to_string();
    let actor_user_id = match read_bearer_token(headers) {
        Some(token) => {
            let actor = bearer_user(&platform.app, &token).await?;
            log(json!({
                "level": "info",
                "event": "auth.bearer_session",
                "actorUserId": actor,
                "requestId": request_id,
                "tokenFingerprint": fingerprint(&token),
            }));
            actor
        }
        None => {
            let token = platform.sessions.read_token(headers).ok_or(ApiError::Unauthorized)?;
            session_user(&platform.auth, &token).await?.ok_or(ApiError::Unauthorized)?
        }
    };
    let client = platform.app.client().await?;
    let row = client
        .query_opt("SELECT status FROM app.get_user_by_id($1::uuid)", &[&actor_user_id])
        .await?
        .ok_or(ApiError::Unauthorized)?;
    match row.get::<_, String>(0).as_str() {
        "pending" => Err(ApiError::AccountState {
            code: "account_pending_approval",
            message: "Account is pending approval",
        }),
        "deactivated" => Err(ApiError::AccountState {
            code: "account_deactivated",
            message: "Account has been deactivated",
        }),
        _ => Ok(AccessContext::new(actor_user_id, request_id)),
    }
}

/// The legacy bearer token is a session id; `app.resolve_auth_session` enforces expiry.
async fn bearer_user(app: &Database, token: &str) -> Result<Uuid, ApiError> {
    if !is_uuid(token) {
        return Err(ApiError::Unauthorized);
    }
    let session_id = Uuid::parse_str(token).map_err(|_| ApiError::Unauthorized)?;
    let client = app.client().await?;
    let row = client
        .query_opt("SELECT user_id FROM app.resolve_auth_session($1::uuid)", &[&session_id])
        .await?
        .ok_or(ApiError::Unauthorized)?;
    Ok(row.get(0))
}

/// `GET /api/me`: the signed-in user, read through the data context.
async fn me(
    State(platform): State<Arc<Platform>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let access = resolve_access(&platform, &headers).await?;
    let cx = DataContext::open(&platform.app, &access).await?;
    let sql = format!("SELECT {USER_FIELDS} FROM app.get_user_by_id($1::uuid)");
    let row =
        cx.db().query_opt(&sql, &[&access.actor_user_id()]).await?.ok_or(ApiError::Unauthorized)?;
    cx.commit().await?;
    Ok(json_reply(200, &json!({ "user": serialize_user(&row) })))
}

pub fn routes() -> Router<Arc<Platform>> {
    Router::new()
        .route("/api/auth/sign-up/email", post(sign_up))
        .route("/api/auth/sign-in/email", post(sign_in))
        .route("/api/auth/sign-out", post(sign_out))
        .route("/api/me", get(me))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

    /// Node: createHmac("sha256", TEST_AUTH_SECRET).update(TOKEN).digest("base64").
    const NODE_SIGNATURE: &str = "5ozzw4zbLYnn+dL54X0cltoXk59H7NB5pB1OjtYSJQs=";

    fn cookies(secure: bool) -> SessionCookies {
        SessionCookies { secret: Secret::new(TEST_AUTH_SECRET), secure }
    }

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    fn with_cookie_header(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn signs_cookies_like_better_auth() {
        let cookies = cookies(false);
        assert_eq!(cookies.sign(TOKEN), NODE_SIGNATURE);
        let set = cookies.set_cookie(TOKEN);
        assert_eq!(
            set,
            format!(
                "better-auth.session_token={TOKEN}.{}; Max-Age=604800; Path=/; HttpOnly; \
                 SameSite=Lax",
                encode_uri_component(NODE_SIGNATURE)
            )
        );
        let value = set.split_once('=').unwrap().1.split(';').next().unwrap();
        let headers = with_cookie_header(&format!("theme=dark; {SESSION_COOKIE}={value}"));
        assert_eq!(cookies.read_token(&headers).as_deref(), Some(TOKEN));
    }

    #[test]
    fn refuses_tampered_or_misshapen_cookies() {
        let cookies = cookies(false);
        let good = encode_uri_component(&format!("{TOKEN}.{NODE_SIGNATURE}"));
        let tampered = good.replacen("5ozz", "5ozy", 1);
        let other_token = good.replacen("AbCd", "AbCe", 1);
        let unpadded = encode_uri_component(&format!("{TOKEN}.{}", &NODE_SIGNATURE[..43]));
        for value in [tampered.as_str(), other_token.as_str(), unpadded.as_str(), TOKEN, "%zz"] {
            let headers = with_cookie_header(&format!("{SESSION_COOKIE}={value}"));
            assert_eq!(cookies.read_token(&headers), None, "{value}");
        }
        let plain_name = with_cookie_header(&format!("{SESSION_COOKIE}={good}"));
        assert_eq!(super::SessionCookies::read_token(&self::cookies(true), &plain_name), None);
        let secure = with_cookie_header(&format!("{SECURE_SESSION_COOKIE}={good}"));
        assert_eq!(self::cookies(true).read_token(&secure).as_deref(), Some(TOKEN));
        assert!(self::cookies(true).set_cookie(TOKEN).ends_with("; Secure"));
    }

    #[test]
    fn resolves_the_signing_secret_like_typescript() {
        let named = auth_secret(&env(&[("BETTER_AUTH_SECRET", "one"), ("AUTH_SECRET", "two")]));
        assert!(named.unwrap().matches("one"));
        let fallback = auth_secret(&env(&[("AUTH_SECRET", "two")]));
        assert!(fallback.unwrap().matches("two"));
        let empty_first = auth_secret(&env(&[("BETTER_AUTH_SECRET", ""), ("AUTH_SECRET", "two")]));
        let empty_first = empty_first.unwrap();
        assert!(!empty_first.matches("two"));
        assert_eq!(empty_first.expose_secret().len(), 64);
        assert!(auth_secret(&env(&[("VITEST", "true")])).unwrap().matches(TEST_AUTH_SECRET));
        assert!(auth_secret(&env(&[("NODE_ENV", "test")])).unwrap().matches(TEST_AUTH_SECRET));
        let production = auth_secret(&env(&[("NODE_ENV", "production")]));
        assert_eq!(production.err().unwrap(), "BETTER_AUTH_SECRET is required in production");
    }

    #[test]
    fn reads_trust_proxy_like_typescript() {
        assert_eq!(trust_proxy(&env(&[])), Ok(false));
        assert_eq!(trust_proxy(&env(&[("JARVIS_TRUST_PROXY", "  ")])), Ok(false));
        assert_eq!(trust_proxy(&env(&[("JARVIS_TRUST_PROXY", "Loopback")])), Ok(true));
        assert_eq!(trust_proxy(&env(&[("JARVIS_TRUST_PROXY", "10.0.0.1, ::1")])), Ok(true));
        assert!(trust_proxy(&env(&[("JARVIS_TRUST_PROXY", "yes")])).is_err());
        assert!(trust_proxy(&env(&[("JARVIS_TRUST_PROXY", "10.0.0.1,")])).is_err());
        let moss_first = env(&[("MOSS_TRUST_PROXY", ""), ("JARVIS_TRUST_PROXY", "loopback")]);
        assert_eq!(trust_proxy(&moss_first), Ok(false));
    }

    #[test]
    fn reads_bearer_like_typescript() {
        let read = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(AUTHORIZATION, HeaderValue::from_str(value).unwrap());
            read_bearer_token(&headers)
        };
        assert_eq!(read("Bearer abc").as_deref(), Some("abc"));
        assert_eq!(read("bEaReR   abc extra").as_deref(), Some("abc"));
        assert_eq!(read(" Bearer abc"), None);
        assert_eq!(read("Basic abc"), None);
        assert_eq!(read("Bearer"), None);
    }

    #[test]
    fn accepts_only_hyphenated_uuids() {
        assert!(is_uuid("6F9619FF-8B86-D011-B42D-00C04FC964FF"));
        assert!(!is_uuid("6f9619ff8b86d011b42d00c04fc964ff"));
        assert!(!is_uuid("{6f9619ff-8b86-d011-b42d-00c04fc964ff}"));
    }

    #[test]
    fn checks_emails_like_zod() {
        for good in ["a@b.co", "first.last+tag@sub.example.org", "o'neil_1@x-y.io"] {
            assert!(is_email(good), "{good}");
        }
        for bad in ["a@b", "a..b@c.com", ".a@b.com", "a.@b.com", "a@-b.com", "a@b.c", "a b@c.com", "@b.com", "a@b..com"] {
            assert!(!is_email(bad), "{bad}");
        }
    }

    #[test]
    fn makes_tokens_and_fingerprints_that_hold_no_secret() {
        let token = new_session_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|ch| ch.is_ascii_alphanumeric()));
        let print = fingerprint(TOKEN);
        assert_eq!(print.len(), 12);
        assert!(!TOKEN.contains(&print));
    }

    #[test]
    fn round_trips_uri_components() {
        let text = "a+b/c=d é";
        assert_eq!(encode_uri_component(text), "a%2Bb%2Fc%3Dd%20%C3%A9");
        assert_eq!(decode_uri_component(&encode_uri_component(text)).as_deref(), Some(text));
        assert_eq!(decode_uri_component("%E9"), None);
        assert_eq!(decode_uri_component("%4"), None);
    }
}
