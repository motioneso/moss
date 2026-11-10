//! The shared server state, the platform routes and the one log writer.
//!
//! Every log line goes through [`log`], which redacts the whole value before it is written, so
//! a handler cannot put a token, password or credential into the log by accident.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::Router;
use chrono::Utc;
use serde_json::{json, Value};

use crate::auth::SessionCookies;
use crate::db::Database;
use crate::origin::TrustedOrigins;
use crate::redact::redact_json;
use crate::secret::SecretCipher;
use crate::{admin, auth, views};

/// What every platform route needs: one pool per runtime role, the cookie signer, the
/// connector cipher and the pages trusted to sign in.
pub struct Platform {
    /// `jarvis_app_runtime`. Every signed-in read and write runs here in a data context.
    pub app: Database,
    /// `jarvis_auth_runtime`. Users, credential accounts and sessions only.
    pub auth: Database,
    pub sessions: SessionCookies,
    pub connectors: SecretCipher,
    pub origins: TrustedOrigins,
}

/// Writes one redacted JSON line to stderr, with the time added.
pub fn log(mut line: Value) {
    if let Value::Object(fields) = &mut line {
        fields.insert("time".into(), Value::from(Utc::now().timestamp_millis()));
    }
    eprintln!("{}", redact_json(&line));
}

fn routes() -> Router<Arc<Platform>> {
    Router::new()
        .merge(auth::routes())
        .merge(admin::routes())
        .merge(views::routes())
}

/// The whole server: `extra` (a feature's own routes and fallback) plus every platform route,
/// with one request log line for each request.
pub fn app(platform: Arc<Platform>, extra: Router) -> Router {
    extra
        .merge(routes().with_state(platform))
        .layer(middleware::from_fn(request_log))
}

async fn request_log(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let started = Instant::now();
    let response = next.run(request).await;
    log(request_line(
        method.as_str(),
        &path,
        response.status().as_u16(),
        started.elapsed(),
    ));
    response
}

/// The query string is left out because it can carry a token.
fn request_line(method: &str, path: &str, status: u16, took: Duration) -> Value {
    json!({
        "level": "info",
        "event": "request",
        "method": method,
        "path": path,
        "status": status,
        "ms": u64::try_from(took.as_millis()).unwrap_or(u64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use axum::http::Uri;

    use super::*;

    #[test]
    fn platform_routes_do_not_overlap() {
        let _ = routes();
    }

    #[test]
    fn request_lines_leave_out_the_query_string() {
        let uri: Uri = "/api/me?token=MOSS-SENTINEL-query-51aa".parse().unwrap();
        let line = request_line("GET", uri.path(), 200, Duration::from_millis(3));
        assert_eq!(
            line,
            json!({
                "level": "info",
                "event": "request",
                "method": "GET",
                "path": "/api/me",
                "status": 200,
                "ms": 3,
            })
        );
    }
}
