//! Bearer check for companion devices (Trail Marker on a Mac, the Android voice ring).
//!
//! A device credential opens a short allow-list of paths and nothing else. The credential is
//! hashed here and only the hash reaches the database. The device id of an admitted request
//! goes into the shared per-request map, never the credential.
use crate::{
    access::AccessContext,
    auth::read_bearer_token,
    device_requests::DeviceRequests,
    error::ApiError,
    http::Platform,
};
use axum::http::{HeaderMap, Method};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const MAC_PREFIX: &str = "tm1_";
pub const RING_PREFIX: &str = "vr1_";
pub const ACT_AS_HEADER: &str = "x-moss-act-as";
const REFUSED: &str = "Open Moss to manage your account.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Mac,
    Ring,
}

/// The credential in the bearer header when it has a companion shape, with its kind.
pub fn companion_bearer(headers: &HeaderMap) -> Option<(Kind, String)> {
    let token = read_bearer_token(headers)?;
    let kind = if token.starts_with(MAC_PREFIX) {
        Kind::Mac
    } else if token.starts_with(RING_PREFIX) {
        Kind::Ring
    } else {
        return None;
    };
    Some((kind, token))
}

fn shaped(token: &str, prefix: &str) -> bool {
    token.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 43 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

/// The raw bearer credential, for the handlers that run before sign-in and so have no device
/// in the per-request map. It goes straight to a hash and is never stored or logged.
pub fn read_credential(headers: &HeaderMap) -> Option<String> {
    read_bearer_token(headers)
}

pub fn digest(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

/// Paths that run before any sign-in. They resolve no account.
pub fn before_sign_in(path: &str) -> bool {
    matches!(
        path,
        "/api/companion/protocol"
            | "/api/companion/pair"
            | "/api/companion/pair/redeem"
            | "/api/companion/pair/cancel"
            | "/api/companion/logout"
            | "/api/companion/ring-session"
            | "/api/companion/ring-logout"
    )
}

/// What a Mac credential may call.
pub fn mac_allowed(path: &str) -> bool {
    matches!(
        path,
        "/api/companion/heartbeat"
            | "/api/companion/device"
            | "/api/companion/backtrack"
            | "/api/companion/focus/context"
            | "/api/companion/focus/judge"
            | "/api/companion/focus/correct"
    )
}

/// What a ring credential may call: recording and voice paths, and one voice request read.
pub fn ring_allowed(method: &Method, path: &str) -> bool {
    for base in [
        "/api/meetings/recording-imports",
        "/api/meetings/recording-uploads",
        "/api/meetings/voice-enablement",
        "/api/meetings/voice-recordings",
    ] {
        if path == base || path.strip_prefix(base).is_some_and(|r| r.starts_with('/')) {
            return true;
        }
    }
    method == Method::GET
        && path.strip_prefix("/api/chat/voice-requests/").is_some_and(|id| {
            id.len() == 36 && id.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9' | b'-'))
        })
}

/// A resolved device request.
pub struct Admitted {
    pub access: AccessContext,
    pub device: Uuid,
    pub kind: Kind,
}

/// Checks the path allow-list, then resolves the credential. An invalid credential is 401, a
/// path outside the allow-list is 403, and pending or deactivated accounts are refused.
pub async fn admit(
    platform: &Platform,
    headers: &HeaderMap,
    method: &Method,
    path: &str,
    kind: Kind,
    token: &str,
) -> Result<Admitted, ApiError> {
    let allowed = match kind {
        Kind::Mac => mac_allowed(path),
        Kind::Ring => ring_allowed(method, path),
    };
    if !allowed {
        return Err(ApiError::http(403, REFUSED));
    }
    if headers.contains_key(ACT_AS_HEADER) {
        return Err(ApiError::http(403, REFUSED));
    }
    let prefix = if kind == Kind::Mac { MAC_PREFIX } else { RING_PREFIX };
    if !shaped(token, prefix) {
        return Err(invalid());
    }
    let db = platform.app.client().await?;
    let hash = digest(token);
    let row = db
        .query_opt("SELECT user_id, device_id, platform FROM app.resolve_companion_device($1)", &[&hash])
        .await?
        .ok_or_else(invalid)?;
    let (user, device, device_platform): (Uuid, Uuid, String) = (row.get(0), row.get(1), row.get(2));
    // A Mac credential belongs to a macOS device and a ring credential to an Android one.
    if (kind == Kind::Mac) != (device_platform == "macos") {
        return Err(invalid());
    }
    let status: String = db
        .query_opt("SELECT status FROM app.get_user_by_id($1::uuid)", &[&user])
        .await?
        .ok_or_else(invalid)?
        .get(0);
    match status.as_str() {
        "pending" => {
            return Err(ApiError::AccountState {
                code: "account_pending_approval",
                message: "Your account is waiting for approval.",
            })
        }
        "deactivated" => {
            return Err(ApiError::AccountState {
                code: "account_deactivated",
                message: "Your account has been deactivated.",
            })
        }
        _ => {}
    }
    Ok(Admitted { access: AccessContext::new(user, Uuid::new_v4().to_string()), device, kind })
}

fn invalid() -> ApiError {
    ApiError::Http { status: 401, message: "Companion credential is missing or invalid".into() }
}

/// Records the device for the request id and removes it when dropped.
pub struct Scoped {
    map: DeviceRequests,
    request_id: String,
}

impl Scoped {
    pub fn new(map: DeviceRequests, request_id: &str, device: Uuid) -> Self {
        map.insert(request_id, device);
        Self { map, request_id: request_id.to_owned() }
    }
}

impl Drop for Scoped {
    fn drop(&mut self) {
        self.map.remove(&self.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_reaches_only_recording_and_voice_paths() {
        let get = Method::GET;
        assert!(ring_allowed(&Method::POST, "/api/meetings/recording-uploads"));
        assert!(ring_allowed(&Method::POST, "/api/meetings/voice-recordings/abc/finish"));
        assert!(ring_allowed(&get, "/api/chat/voice-requests/0a1b2c3d-0000-4000-8000-000000000000"));
        for path in [
            "/api/meetings",
            "/api/meetings/recording-importsX",
            "/api/me",
            "/api/companion/heartbeat",
            "/api/chat/voice-requests/not-an-id",
            "/api/finance/accounts",
        ] {
            assert!(!ring_allowed(&get, path), "{path}");
        }
        assert!(!ring_allowed(&Method::POST, "/api/chat/voice-requests/0a1b2c3d-0000-4000-8000-000000000000"));
    }

    #[test]
    fn mac_reaches_only_its_six_paths() {
        assert!(mac_allowed("/api/companion/backtrack"));
        assert!(!mac_allowed("/api/me"));
        assert!(!mac_allowed("/api/companion/pair/decide"));
    }

    #[test]
    fn credential_shape_is_prefix_plus_43_url_safe_characters() {
        let ok = format!("tm1_{}", "a".repeat(43));
        assert!(shaped(&ok, MAC_PREFIX));
        assert!(!shaped(&ok, RING_PREFIX));
        assert!(!shaped(&format!("tm1_{}", "a".repeat(42)), MAC_PREFIX));
        assert!(!shaped(&format!("tm1_{}!", "a".repeat(42)), MAC_PREFIX));
    }
}
