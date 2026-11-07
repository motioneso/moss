//! Request sign-in: the legacy session bearer path of `resolveRequestAccessContext`.
//!
//! The bearer token is an `auth_sessions` id. `app.resolve_auth_session` enforces expiry in SQL,
//! then `app.get_user_by_id` rejects pending and deactivated accounts. Cookie sessions are not
//! part of this spike. The token is never logged.

use axum::http::HeaderMap;
use deadpool_postgres::Pool;
use uuid::Uuid;

use crate::db::AccessContext;
use crate::error::ApiError;

/// `authorization.split(/\s+/, 2)` with a case-insensitive `bearer` scheme.
pub fn read_bearer_token(headers: &HeaderMap) -> Option<String> {
    let header = headers.get("authorization")?.to_str().ok()?;
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

pub async fn resolve_access(pool: &Pool, headers: &HeaderMap) -> Result<AccessContext, ApiError> {
    let token = read_bearer_token(headers).ok_or(ApiError::Unauthorized)?;
    if !is_uuid(&token) {
        return Err(ApiError::Unauthorized);
    }
    let session_id = Uuid::parse_str(&token).map_err(|_| ApiError::Unauthorized)?;
    let client = pool.get().await?;
    let session = client
        .query_opt("SELECT user_id FROM app.resolve_auth_session($1::uuid)", &[&session_id])
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let actor_user_id: Uuid = session.get(0);
    let user = client
        .query_opt("SELECT status::text FROM app.get_user_by_id($1::uuid)", &[&actor_user_id])
        .await?
        .ok_or(ApiError::Unauthorized)?;
    match user.get::<_, String>(0).as_str() {
        "pending" => Err(ApiError::AccountState {
            code: "account_pending_approval",
            message: "Account is pending approval",
        }),
        "deactivated" => Err(ApiError::AccountState {
            code: "account_deactivated",
            message: "Account has been deactivated",
        }),
        _ => Ok(AccessContext { actor_user_id, request_id: Uuid::new_v4().to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(value: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert("authorization", HeaderValue::from_str(value).unwrap());
        map
    }

    #[test]
    fn reads_bearer_like_typescript() {
        assert_eq!(read_bearer_token(&headers("Bearer abc")).as_deref(), Some("abc"));
        assert_eq!(read_bearer_token(&headers("bearer   abc  def")).as_deref(), Some("abc"));
        assert_eq!(read_bearer_token(&headers(" Bearer abc")), None);
        assert_eq!(read_bearer_token(&headers("Basic abc")), None);
        assert_eq!(read_bearer_token(&headers("Bearer")), None);
    }

    #[test]
    fn accepts_only_hyphenated_uuids() {
        assert!(is_uuid("00000000-0000-4000-8000-00000000000A"));
        assert!(!is_uuid("000000000000400080000000000000a1"));
        assert!(!is_uuid("{00000000-0000-4000-8000-000000000001}"));
    }
}
