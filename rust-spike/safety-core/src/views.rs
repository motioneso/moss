//! Connector accounts: the API view of rows that hold a sealed credential.
//!
//! A connector's credential is sealed with [`SecretCipher`] before it reaches the database, and
//! no reply carries the envelope back. The account view reports only whether a secret exists.
//! Every query runs in the caller's data context, so row-level security limits each user to
//! their own accounts. Matches `packages/connectors/src/routes.ts`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::{iso, resolve_access};
use crate::db::DataContext;
use crate::error::{json_reply, ApiError};
use crate::http::Platform;
use crate::secret::{Secret, SecretFields};

/// Has its own connect flow and cannot be created here.
const OUTLOOK_BROWSER_PROVIDER: &str = "outlook-browser-calendar";

/// The safe account columns. The envelope column is only ever tested for presence.
const ACCOUNT_SELECT: &str = "\
    SELECT accounts.id, accounts.provider_id, definitions.provider_type::text AS provider_type, \
           definitions.display_name AS provider_display_name, \
           definitions.status::text AS provider_status, accounts.owner_user_id, accounts.scopes, \
           accounts.status::text AS status, \
           accounts.encrypted_secret IS NOT NULL AS has_secret, \
           accounts.revoked_at, accounts.created_at, accounts.updated_at, \
           accounts.last_sync_started_at, accounts.last_sync_finished_at, \
           accounts.last_sync_status, accounts.last_sync_error, accounts.last_sync_counts \
    FROM app.connector_accounts AS accounts \
    JOIN app.connector_definitions AS definitions \
      ON definitions.provider_id = accounts.provider_id";

/// Database refusals that mean the request itself was wrong.
const INVALID_REQUEST_FRAGMENTS: [&str; 3] = [
    "foreign key",
    "violates row-level security policy",
    "duplicate key",
];

pub fn routes() -> Router<Arc<Platform>> {
    Router::new().route(
        "/api/connectors/accounts",
        get(list_accounts).post(create_account),
    )
}

/// `serializeAccount`.
fn serialize_account(row: &Row) -> Value {
    let time = |name: &str| row.get::<_, Option<DateTime<Utc>>>(name).map(iso);
    json!({
        "id": row.get::<_, Uuid>("id"),
        "providerId": row.get::<_, String>("provider_id"),
        "providerType": row.get::<_, String>("provider_type"),
        "providerDisplayName": row.get::<_, String>("provider_display_name"),
        "providerStatus": row.get::<_, String>("provider_status"),
        "ownerUserId": row.get::<_, Uuid>("owner_user_id"),
        "scopes": row.get::<_, Vec<String>>("scopes"),
        "status": row.get::<_, String>("status"),
        "hasSecret": row.get::<_, bool>("has_secret"),
        "revokedAt": time("revoked_at"),
        "createdAt": iso(row.get("created_at")),
        "updatedAt": iso(row.get("updated_at")),
        "lastSyncStartedAt": time("last_sync_started_at"),
        "lastSyncFinishedAt": time("last_sync_finished_at"),
        "lastSyncStatus": row.get::<_, Option<String>>("last_sync_status"),
        "lastSyncError": row.get::<_, Option<String>>("last_sync_error"),
        "lastSyncCounts": row.get::<_, Option<Value>>("last_sync_counts"),
    })
}

async fn list_accounts(
    State(platform): State<Arc<Platform>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let access = resolve_access(&platform, &headers).await?;
    let cx = DataContext::open(&platform.app, &access).await?;
    let sql = format!("{ACCOUNT_SELECT} ORDER BY accounts.created_at DESC, accounts.id");
    let rows = cx.db().query(&sql, &[]).await?;
    cx.commit().await?;
    let accounts: Vec<Value> = rows.iter().map(serialize_account).collect();
    Ok(json_reply(200, &json!({ "accounts": accounts })))
}

struct NewAccount {
    provider_id: String,
    scopes: Vec<String>,
    status: String,
    secret: SecretFields,
}

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError::http(400, message)
}

fn optional_string(value: Option<&Value>, field: &str) -> Result<Option<String>, ApiError> {
    match value {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(bad_request(format!("{field} must be a string"))),
    }
}

fn required_string(value: Option<&Value>, field: &str) -> Result<String, ApiError> {
    optional_string(value, field)?
        .filter(|text| !text.is_empty())
        .ok_or_else(|| bad_request(format!("{field} is required")))
}

/// `parseCreateAccountBody`. The credential becomes [`Secret`] values as soon as it is read.
/// The cipher seals text, so a credential field that is not a string is refused.
fn parse_new_account(body: &Bytes) -> Result<NewAccount, ApiError> {
    let mut body = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(fields)) => fields,
        _ => return Err(bad_request("Expected JSON object body")),
    };
    let provider_id = required_string(body.get("providerId"), "providerId")?;
    let scopes = match body.get("scopes") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| required_string(Some(item), &format!("scopes[{index}]")))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(bad_request("scopes must be an array")),
    };
    let status = match body.get("status") {
        None => "active".to_owned(),
        Some(Value::String(status)) if status == "active" || status == "error" => status.clone(),
        Some(_) => return Err(bad_request("status must be active or error")),
    };
    let payload = match body.remove("tokenPayload") {
        Some(Value::Object(payload)) => payload,
        _ => return Err(bad_request("tokenPayload must be a JSON object")),
    };
    Ok(NewAccount {
        provider_id,
        scopes,
        status,
        secret: seal_ready(payload)?,
    })
}

fn seal_ready(payload: Map<String, Value>) -> Result<SecretFields, ApiError> {
    let mut fields = SecretFields::new();
    for (name, value) in payload {
        match value {
            Value::String(text) => fields = fields.with(name, Secret::new(text)),
            _ => return Err(bad_request("tokenPayload values must be strings")),
        }
    }
    Ok(fields)
}

async fn create_account(
    State(platform): State<Arc<Platform>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let access = resolve_access(&platform, &headers).await?;
    let account = parse_new_account(&body)?;
    if account.provider_id == OUTLOOK_BROWSER_PROVIDER {
        return Err(ApiError::http(
            403,
            "Use the dedicated Outlook calendar connection.",
        ));
    }
    let sealed = platform.connectors.seal(&account.secret);
    let cx = DataContext::open(&platform.app, &access).await?;
    let id = Uuid::new_v4();
    cx.db()
        .execute(
            "INSERT INTO app.connector_accounts \
               (id, provider_id, owner_user_id, scopes, status, encrypted_secret, revoked_at, \
                created_at, updated_at) \
             VALUES ($1, $2, app.current_actor_user_id(), $3, \
                     ($4::text)::app.connector_account_status, $5, NULL, now(), now())",
            &[
                &id,
                &account.provider_id,
                &account.scopes,
                &account.status,
                &sealed,
            ],
        )
        .await
        .map_err(ApiError::from)
        .map_err(
            |error| match error.db_message_contains(&INVALID_REQUEST_FRAGMENTS) {
                true => bad_request("Connector account request is invalid"),
                false => error,
            },
        )?;
    let row = cx
        .db()
        .query_one(&format!("{ACCOUNT_SELECT} WHERE accounts.id = $1"), &[&id])
        .await?;
    cx.commit().await?;
    Ok(json_reply(
        201,
        &json!({ "account": serialize_account(&row) }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENTINEL: &str = "MOSS-SENTINEL-connector-7c1d";

    fn parse(body: Value) -> Result<NewAccount, (u16, Value)> {
        parse_new_account(&Bytes::from(body.to_string())).map_err(ApiError::status_and_body)
    }

    fn refusal(message: &str) -> (u16, Value) {
        (400, json!({ "error": message }))
    }

    #[test]
    fn reads_a_new_account_with_ts_defaults() {
        let account =
            parse(json!({ "providerId": "google", "tokenPayload": { "refreshToken": SENTINEL } }))
                .ok()
                .unwrap();
        assert_eq!(account.provider_id, "google");
        assert!(account.scopes.is_empty());
        assert_eq!(account.status, "active");
        assert!(account
            .secret
            .get("refreshToken")
            .unwrap()
            .matches(SENTINEL));
    }

    #[test]
    fn refuses_bodies_the_ts_server_refuses() {
        let cases = [
            (json!([]), "Expected JSON object body"),
            (json!({ "tokenPayload": {} }), "providerId is required"),
            (
                json!({ "providerId": "", "tokenPayload": {} }),
                "providerId is required",
            ),
            (
                json!({ "providerId": 7, "tokenPayload": {} }),
                "providerId must be a string",
            ),
            (
                json!({ "providerId": "g", "scopes": "a", "tokenPayload": {} }),
                "scopes must be an array",
            ),
            (
                json!({ "providerId": "g", "scopes": [1], "tokenPayload": {} }),
                "scopes[0] must be a string",
            ),
            (
                json!({ "providerId": "g", "status": "revoked", "tokenPayload": {} }),
                "status must be active or error",
            ),
            (
                json!({ "providerId": "g" }),
                "tokenPayload must be a JSON object",
            ),
            (
                json!({ "providerId": "g", "tokenPayload": [] }),
                "tokenPayload must be a JSON object",
            ),
        ];
        for (body, message) in cases {
            assert_eq!(parse(body.clone()).err(), Some(refusal(message)), "{body}");
        }
    }

    /// A refused credential is never echoed back in the error.
    #[test]
    fn refuses_non_text_credentials_without_echoing_them() {
        let body = json!({ "providerId": "g", "tokenPayload": { "token": [SENTINEL] } });
        let error = parse(body).err().unwrap();
        assert_eq!(error, refusal("tokenPayload values must be strings"));
        assert!(!error.1.to_string().contains(SENTINEL));
    }

    #[test]
    fn routes_build() {
        let _ = routes();
    }
}
