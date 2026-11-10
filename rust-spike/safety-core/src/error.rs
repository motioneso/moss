//! Error replies with the same status codes and bodies as the TypeScript server.
//!
//! Handler errors follow `handleRouteError`. Errors raised before the handler (body parsing,
//! schema checks) follow `setMossErrorHandler`, which answers `{ error }` with the error's own
//! status and hides the text of any 5xx. Internal detail goes to the log, redacted.

use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

#[derive(Debug)]
pub enum ApiError {
    /// `HttpError` thrown by a handler.
    Http { status: u16, message: String },
    /// A Fastify error raised before the handler ran.
    Framework { status: u16, message: String },
    /// "Session is missing or expired".
    Unauthorized,
    /// Pending or deactivated account.
    AccountState {
        code: &'static str,
        message: &'static str,
    },
    /// Anything unmapped; the detail stays in the server log.
    Internal(String),
}

impl ApiError {
    pub fn http(status: u16, message: impl Into<String>) -> Self {
        ApiError::Http {
            status,
            message: message.into(),
        }
    }

    pub fn framework(status: u16, message: impl Into<String>) -> Self {
        ApiError::Framework {
            status,
            message: message.into(),
        }
    }

    /// The Postgres message, which the TypeScript repositories match on for 409 replies.
    pub fn db_message(&self) -> Option<&str> {
        match self {
            ApiError::Internal(detail) => detail.split_once(": ").map(|(_, message)| message),
            _ => None,
        }
    }

    /// `err.message.includes(...)` for any of `needles`.
    pub fn db_message_contains(&self, needles: &[&str]) -> bool {
        self.db_message()
            .is_some_and(|message| needles.iter().any(|n| message.contains(n)))
    }
}

impl From<tokio_postgres::Error> for ApiError {
    fn from(error: tokio_postgres::Error) -> Self {
        let detail = match error.as_db_error() {
            Some(db) => format!("{}: {}", db.code().code(), db.message()),
            None => format!("client: {error}"),
        };
        ApiError::Internal(detail)
    }
}

impl From<deadpool_postgres::PoolError> for ApiError {
    fn from(error: deadpool_postgres::PoolError) -> Self {
        ApiError::Internal(format!("pool: {error}"))
    }
}

impl ApiError {
    pub fn status_and_body(self) -> (u16, Value) {
        match self {
            ApiError::Http { status, message } => (status, json!({ "error": message })),
            ApiError::Framework { status, message } if status < 500 => {
                (status, json!({ "error": message }))
            }
            ApiError::Framework { status, .. } => {
                (status, json!({ "error": "Internal Server Error" }))
            }
            ApiError::Unauthorized => (401, json!({ "error": "Session is missing or expired" })),
            ApiError::AccountState { code, message } => {
                (403, json!({ "error": message, "code": code }))
            }
            ApiError::Internal(detail) => {
                crate::http::log(
                    json!({ "level": "error", "msg": "unhandled route error", "detail": detail }),
                );
                (500, json!({ "error": "Internal server error" }))
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, body) = self.status_and_body();
        json_reply(status, &body)
    }
}

/// A JSON reply with the content type Fastify sends.
pub fn json_reply(status: u16, body: &Value) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let headers = [(CONTENT_TYPE, "application/json; charset=utf-8")];
    (status, headers, body.to_string()).into_response()
}
