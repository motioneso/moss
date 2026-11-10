//! Notification identities and durable desktop acceptance; never notification reads.
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use safety_core::{access::AccessContext, error::ApiError};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

use crate::Accounts;

#[derive(Default, Deserialize)]
pub struct Client {
    client: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Acceptance {
    client: Uuid,
    events: Vec<Uuid>,
}

/// Identity-only polling remains compatible with older apps which do not send a client ID.
pub async fn list(
    State(data): State<Arc<Accounts>>,
    Extension(access): Extension<AccessContext>,
    Query(client): Query<Client>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let cx = safety_core::db::DataContext::open(&data.platform.app, &access).await?;
    let rows = cx
        .db()
        .query(
            "SELECT n.id::text, EXISTS (
           SELECT 1 FROM app.desktop_notification_receipts r
           WHERE r.notification_id=n.id AND r.user_id=$1 AND r.client_id=$2
         ) FROM app.notifications n
         WHERE n.recipient_user_id=$1 AND NOT EXISTS (
           SELECT 1 FROM app.notification_reads r WHERE r.notification_id=n.id AND r.user_id=$1
         ) ORDER BY n.updated_at DESC, n.id DESC LIMIT 100",
            &[&access.actor_user_id(), &client.client],
        )
        .await?;
    let events: Vec<String> = rows.iter().map(|row| row.get(0)).collect();
    let acknowledged: Vec<String> = rows
        .iter()
        .filter(|row| row.get::<_, bool>(1))
        .map(|row| row.get(0))
        .collect();
    cx.commit().await?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(
            serde_json::json!({"account": access.actor_user_id(), "events": events, "acknowledged": acknowledged}),
        ),
    ))
}

/// Only the authenticated recipient's existing notifications can be accepted. Retrying a
/// committed batch is harmless, including when the client lost the first response.
pub async fn accept(
    State(data): State<Arc<Accounts>>,
    Extension(access): Extension<AccessContext>,
    Json(body): Json<Acceptance>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    if body.events.is_empty() || body.events.len() > 100 {
        return Err(ApiError::http(
            400,
            "Accept between one and one hundred notification IDs",
        ));
    }
    let cx = safety_core::db::DataContext::open(&data.platform.app, &access).await?;
    let rows = cx
        .db()
        .query(
            "SELECT id FROM app.notifications WHERE recipient_user_id=$1 AND id=ANY($2)",
            &[&access.actor_user_id(), &body.events],
        )
        .await?;
    let events: Vec<Uuid> = rows.iter().map(|row| row.get(0)).collect();
    cx.db()
        .execute(
            "INSERT INTO app.desktop_notification_receipts(user_id,client_id,notification_id)
         SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING",
            &[&access.actor_user_id(), &body.client, &events],
        )
        .await?;
    cx.commit().await?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"account": access.actor_user_id(), "acknowledged": events})),
    ))
}
