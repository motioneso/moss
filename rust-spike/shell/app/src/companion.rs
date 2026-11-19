//! Trail Marker and Android ring pairing routes. The routes are mounted by the shell so they
//! work before sign-in. The credential checks for signed-in device calls live in
//! `safety_core::companion_gate`; every device request reaches these handlers already resolved.
use axum::{
    extract::{rejection::JsonRejection, ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use moss_meetings_host::{
    device_store::DeviceStore,
    pairing::{credential_shape, Decision, NewAttempt, Pending, PairingStore, Redeemed, RING_PREFIX},
};
use safety_core::{
    access::AccessContext, auth, companion_gate::read_credential, db::DataContext,
    device_requests::DeviceRequests, error::ApiError,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;

use crate::Accounts;

const POLL_SECONDS: u64 = 3;

type Reply = Result<Response, ApiError>;

const WINDOW: Duration = Duration::from_secs(60);
const SWEEP_ABOVE: usize = 1024;

type Buckets = HashMap<(&'static str, IpAddr), (Instant, u32)>;

/// Counts one hit in the route's fixed window for this address. Once the map passes
/// `SWEEP_ABOVE` entries, every bucket older than the window is dropped, so memory follows
/// recent traffic and not the number of addresses ever seen.
fn hit(map: &mut Buckets, now: Instant, route: &'static str, ip: IpAddr, max: u32) -> bool {
    if map.len() > SWEEP_ABOVE {
        map.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
    }
    let entry = map.entry((route, ip)).or_insert((now, 0));
    if now.duration_since(entry.0) >= WINDOW {
        *entry = (now, 0);
    }
    entry.1 += 1;
    entry.1 <= max
}

/// The credential is not resolved yet, so only the connecting address can key a bucket.
fn allow(route: &'static str, ip: IpAddr, max: u32) -> bool {
    static BUCKETS: OnceLock<Mutex<Buckets>> = OnceLock::new();
    let mut map = BUCKETS.get_or_init(Default::default).lock().expect("rate buckets");
    hit(&mut map, Instant::now(), route, ip, max)
}

#[cfg(test)]
mod limiter_tests {
    use super::*;

    #[test]
    fn old_buckets_are_dropped_so_the_map_stays_bounded() {
        let mut map = Buckets::new();
        let start = Instant::now();
        for n in 0..(SWEEP_ABOVE as u32 + 200) {
            let ip = IpAddr::from(std::net::Ipv4Addr::from(n));
            hit(&mut map, start, "r", ip, 5);
        }
        assert!(map.len() > SWEEP_ABOVE);
        let later = start + WINDOW + Duration::from_secs(1);
        hit(&mut map, later, "r", IpAddr::from(std::net::Ipv4Addr::new(9, 9, 9, 9)), 5);
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn the_limit_still_applies_inside_one_window() {
        let mut map = Buckets::new();
        let now = Instant::now();
        let ip = IpAddr::from(std::net::Ipv4Addr::LOCALHOST);
        assert!(hit(&mut map, now, "r", ip, 2));
        assert!(hit(&mut map, now, "r", ip, 2));
        assert!(!hit(&mut map, now, "r", ip, 2));
    }
}

fn limited() -> ApiError {
    ApiError::http(429, "Rate limit exceeded")
}

fn json_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    body.map(|Json(v)| v).map_err(|_| ApiError::framework(400, "Request body is invalid"))
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().expect("header"));
    response
}

fn pairing(data: &Accounts) -> PairingStore {
    PairingStore::new(data.platform.auth.clone())
}

fn devices(data: &Accounts) -> DeviceStore {
    DeviceStore::new(data.platform.app.clone())
}

fn internal(e: anyhow::Error) -> ApiError {
    ApiError::Internal(format!("companion: {e}"))
}

pub async fn protocol(ConnectInfo(peer): ConnectInfo<SocketAddr>) -> Reply {
    if !allow("protocol", peer.ip(), 20) {
        return Err(limited());
    }
    Ok(Json(json!({"product":"moss","companionProtocol":1})).into_response())
}

fn clean_name(text: &str) -> bool {
    !text.is_empty() && text.chars().count() <= 64 && !text.chars().any(|c| c.is_control())
}

fn url_safe_43(text: &str) -> bool {
    text.len() == 43 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAttempt {
    device_name: String,
    platform: String,
    app_version: String,
    os_version: String,
    verifier_hash: String,
    recording_proof_hash: Option<String>,
    recording_policy_version: Option<i32>,
}

pub async fn pair(
    State(data): State<Arc<Accounts>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Result<Json<CreateAttempt>, JsonRejection>,
) -> Reply {
    if !allow("pair", peer.ip(), 20) {
        return Err(limited());
    }
    let b = json_body(body)?;
    let proof_ok = b.recording_proof_hash.as_deref().is_none_or(|h| {
        h.len() == 64 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
    });
    if !(clean_name(&b.device_name)
        && matches!(b.platform.as_str(), "macos" | "android")
        && clean_name(&b.app_version)
        && clean_name(&b.os_version)
        && url_safe_43(&b.verifier_hash)
        && proof_ok
        && b.recording_policy_version.is_none_or(|v| v == 1))
    {
        return Err(ApiError::framework(400, "Request body is invalid"));
    }
    let created = pairing(&data)
        .create(NewAttempt {
            verifier_hash: b.verifier_hash,
            device_name: b.device_name,
            platform: b.platform,
            app_version: b.app_version,
            os_version: b.os_version,
            recording_proof_hash: b.recording_proof_hash,
            recording_policy_version: b.recording_policy_version,
        })
        .await
        .map_err(internal)?;
    Ok(Json(json!({
        "attemptId": created.attempt_id,
        "approvalPath": created.approval_path,
        "pollIntervalSeconds": POLL_SECONDS,
        "expiresAt": created.expires_at,
    }))
    .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodeBody {
    code: String,
}

/// Approving a device with a cookie is a state change, so a trusted Origin is required.
fn trusted_origin(data: &Accounts, headers: &HeaderMap) -> Result<(), ApiError> {
    data.platform
        .origins
        .check_auth_post(headers)
        .map_err(|_| ApiError::http(403, "Request origin is not trusted"))
}

/// A signed-in browser, never a bearer: the cookie is the only way in here.
async fn browser_actor(data: &Accounts, headers: &HeaderMap) -> Result<AccessContext, ApiError> {
    if auth::read_bearer_token(headers).is_some() {
        return Err(ApiError::Unauthorized);
    }
    auth::resolve_access(&data.platform, headers).await
}

pub async fn attempt(
    State(data): State<Arc<Accounts>>,
    headers: HeaderMap,
    body: Result<Json<CodeBody>, JsonRejection>,
) -> Reply {
    let b = json_body(body)?;
    trusted_origin(&data, &headers)?;
    browser_actor(&data, &headers).await?;
    // Unknown, expired and finished attempts all answer 404 so a guess learns nothing.
    match pairing(&data).summarize(&b.code).await.map_err(internal)? {
        None => Err(ApiError::http(404, "That link request is no longer open")),
        Some(s) => Ok(Json(json!({
            "deviceName": s.device_name,
            "status": s.status,
            "recordingPolicyVersion": s.recording_policy_version,
            "platform": (s.platform == "android").then_some("android"),
        }))
        .into_response()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decide {
    code: String,
    decision: String,
    recording_policy_version: Option<i32>,
}

pub async fn decide(
    State(data): State<Arc<Accounts>>,
    headers: HeaderMap,
    body: Result<Json<Decide>, JsonRejection>,
) -> Reply {
    let b = json_body(body)?;
    if !matches!(b.decision.as_str(), "approve" | "deny") || b.recording_policy_version.is_some_and(|v| v != 1) {
        return Err(ApiError::framework(400, "Request body is invalid"));
    }
    trusted_origin(&data, &headers)?;
    let actor = browser_actor(&data, &headers).await?.actor_user_id();
    let store = pairing(&data);
    let summary = store.summarize(&b.code).await.map_err(internal)?;
    let mut session = None;
    if summary.as_ref().is_some_and(|s| s.recording_policy_version == Some(1) || s.platform == "android") {
        session = auth::browser_session_id(&data.platform, &headers, actor).await?;
        if session.is_none() {
            return Ok((
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"Sign in to approve this connection","code":"recording_approval_required"})),
            )
                .into_response());
        }
        if summary.as_ref().is_some_and(|s| s.recording_policy_version == Some(1))
            && b.decision == "approve"
            && b.recording_policy_version != Some(1)
        {
            return Ok((
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Review the recording connection permission","code":"recording_policy_required"})),
            )
                .into_response());
        }
    }
    let approve = b.decision == "approve";
    match store.decide(&b.code, approve, actor, session, b.recording_policy_version).await.map_err(internal)? {
        Decision::Done => Ok(Json(json!({"status": if approve {"approved"} else {"denied"}})).into_response()),
        Decision::NotPending => Err(ApiError::http(409, "That link request was already answered")),
        Decision::Unknown => Err(ApiError::http(404, "That link request is no longer open")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attempt {
    attempt_id: Uuid,
    verifier: String,
}

pub async fn redeem(
    State(data): State<Arc<Accounts>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Result<Json<Attempt>, JsonRejection>,
) -> Reply {
    if !allow("redeem", peer.ip(), 120) {
        return Err(limited());
    }
    let b = json_body(body)?;
    Ok(match pairing(&data).redeem(b.attempt_id, &b.verifier).await.map_err(internal)? {
        Redeemed::Issued(i) => no_store(
            Json(json!({
                "status": "issued",
                "credential": i.credential,
                "device": {"id": i.device_id, "displayName": i.display_name},
                "account": {"name": i.account_name, "email": i.account_email, "id": i.account_id},
                "expiresAt": i.expires_at,
                "recordingCapability": i.recording_revision.map(|r| json!({"policyVersion":1,"revision":r})),
            }))
            .into_response(),
        ),
        Redeemed::Not(Pending::Pending) => (StatusCode::ACCEPTED, Json(json!({"status":"pending"}))).into_response(),
        Redeemed::Not(Pending::Denied) => return Err(ApiError::http(403, "The link request was declined")),
        Redeemed::Not(Pending::Expired) => return Err(ApiError::http(410, "The link request expired")),
        Redeemed::Not(Pending::Redeemed) => return Err(ApiError::http(409, "That link request was already used")),
        Redeemed::Not(Pending::Unknown) => return Err(ApiError::http(404, "That link request is no longer open")),
    })
}

pub async fn cancel(
    State(data): State<Arc<Accounts>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Result<Json<Attempt>, JsonRejection>,
) -> Reply {
    if !allow("cancel", peer.ip(), 20) {
        return Err(limited());
    }
    let b = json_body(body)?;
    // The verifier is the whole authorization, and the answer never says whether a row existed.
    pairing(&data).cancel(b.attempt_id, &b.verifier).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn logout(State(data): State<Arc<Accounts>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Reply {
    if !allow("logout", peer.ip(), 20) {
        return Err(limited());
    }
    let credential = read_credential(&headers).ok_or_else(|| companion_invalid())?;
    pairing(&data).logout(&credential).await.map_err(internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn companion_invalid() -> ApiError {
    ApiError::Http { status: 401, message: "Companion credential is missing or invalid".into() }
}

/// The ring asks who it is linked to. The credential is hashed and matched inside the database.
pub async fn ring_session(State(data): State<Arc<Accounts>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Reply {
    if !allow("ring-session", peer.ip(), 60) {
        return Err(limited());
    }
    let credential = read_credential(&headers).filter(|c| credential_shape(c, RING_PREFIX)).ok_or_else(companion_invalid)?;
    let session = pairing(&data).ring_session(&credential).await.map_err(internal)?.ok_or_else(companion_invalid)?;
    Ok(no_store(Json(json!({"ownerId": session.owner, "deviceId": session.device_id})).into_response()))
}

pub async fn ring_logout(State(data): State<Arc<Accounts>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Reply {
    if !allow("ring-logout", peer.ip(), 20) {
        return Err(limited());
    }
    let credential = read_credential(&headers).filter(|c| credential_shape(c, RING_PREFIX)).ok_or_else(companion_invalid)?;
    pairing(&data).logout(&credential).await.map_err(internal)?;
    Ok(no_store(StatusCode::NO_CONTENT.into_response()))
}

fn device_of(access: &AccessContext) -> Result<Uuid, ApiError> {
    DeviceRequests::shared().get(access.request_id()).ok_or_else(companion_invalid)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Beat {
    app_version: String,
    os_version: String,
}

pub async fn heartbeat(
    State(data): State<Arc<Accounts>>,
    Extension(access): Extension<AccessContext>,
    body: Result<Json<Beat>, JsonRejection>,
) -> Reply {
    let b = json_body(body)?;
    let (owner, device) = (access.actor_user_id(), device_of(&access)?);
    let store = devices(&data);
    if !store.heartbeat(owner, device, &b.app_version, &b.os_version).await.map_err(internal)? {
        return Err(companion_invalid());
    }
    let d = store.get(owner, device).await.map_err(internal)?.ok_or_else(companion_invalid)?;
    let cx = DataContext::open(&data.platform.app, &access).await?;
    let user = cx.db().query_one("SELECT u.name, u.email, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         FROM app.get_user_by_id($1::uuid) u", &[&owner]).await?;
    cx.commit().await?;
    Ok(Json(json!({
        "device": {"id": d.id, "displayName": d.display_name},
        "account": {"name": user.get::<_, String>(0), "email": user.get::<_, String>(1)},
        "serverTime": user.get::<_, String>(2),
        "expiresAt": d.expires_at,
    }))
    .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rename {
    display_name: String,
}

pub async fn rename(
    State(data): State<Arc<Accounts>>,
    Extension(access): Extension<AccessContext>,
    body: Result<Json<Rename>, JsonRejection>,
) -> Reply {
    let name = json_body(body)?.display_name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(ApiError::http(400, "Pick a name between 1 and 64 characters"));
    }
    let (owner, device) = (access.actor_user_id(), device_of(&access)?);
    let store = devices(&data);
    if !store.rename(owner, device, &name).await.map_err(internal)? {
        return Err(companion_invalid());
    }
    Ok(Json(json!({"device": {"id": device, "displayName": name}})).into_response())
}


struct Revoker(PairingStore);

impl safety_core::admin::DeviceRevoker for Revoker {
    fn revoke_all_for<'a>(
        &'a self,
        user: Uuid,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64, ApiError>> + Send + 'a>> {
        Box::pin(async move { self.0.revoke_all_for(user).await.map_err(internal) })
    }
}

/// Hands the admin sign-out the store that owns the device rows.
pub fn register_revoker(data: &Accounts) {
    safety_core::admin::set_device_revoker(Arc::new(Revoker(pairing(data))));
}
