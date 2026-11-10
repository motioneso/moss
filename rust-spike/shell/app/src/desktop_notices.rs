//! Desktop alerts for the signed-in person's own notifications. Acceptance is durable and
//! never marks a notification read. The same two handlers serve the web page (session cookie)
//! and the independent notifier (device token, see `network::web`).
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
    /// Version of each notification as it was delivered (from the feed), one per event.
    #[serde(default)]
    versions: Option<Vec<i64>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    client: Uuid,
}

const NO_STORE: [(axum::http::HeaderName, &str); 1] =
    [(axum::http::header::CACHE_CONTROL, "no-store")];

/// Alertable notifications: unread, not held back by quiet hours. A notification counts as
/// accepted only when the receipt is newer than its last update, so a keyed notification that
/// fires again alerts again. Identity-only polling stays compatible with apps that send no
/// client ID.
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
             AND r.accepted_at >= n.updated_at
         ), n.title, n.body, n.href,
           (extract(epoch from n.updated_at) * 1000000)::bigint FROM app.notifications n
         WHERE n.recipient_user_id=$1
           AND (n.deferred_until IS NULL OR n.deferred_until <= now())
           AND NOT EXISTS (
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
    let notices: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "id": row.get::<_, String>(0),
                "title": row.get::<_, String>(2),
                "body": row.get::<_, Option<String>>(3),
                "href": row.get::<_, Option<String>>(4),
                "version": row.get::<_, i64>(5),
            })
        })
        .collect();
    let versions: serde_json::Map<String, serde_json::Value> = rows
        .iter()
        .map(|row| (row.get::<_, String>(0), serde_json::json!(row.get::<_, i64>(5))))
        .collect();
    cx.commit().await?;
    Ok((
        NO_STORE,
        Json(
            serde_json::json!({"account": access.actor_user_id(), "events": events, "acknowledged": acknowledged, "notices": notices, "versions": versions}),
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
    if body.versions.as_ref().is_some_and(|v| v.len() != body.events.len()) {
        return Err(ApiError::http(400, "Send one version per notification ID"));
    }
    // A receipt carries the version that was shown, so a late receipt for an older version
    // never covers a newer update. Without versions the receipt is stamped now.
    let versions: Vec<Option<i64>> = match &body.versions {
        Some(v) => v.iter().map(|n| Some(*n)).collect(),
        None => vec![None; body.events.len()],
    };
    let rows = cx
        .db()
        .query(
            "WITH sent AS (SELECT * FROM unnest($2::uuid[], $4::bigint[]) AS t(id, version))
             INSERT INTO app.desktop_notification_receipts(user_id,client_id,notification_id,accepted_at)
             SELECT $1,$3,n.id,
                    COALESCE(least(now(), timestamptz 'epoch' + s.version * interval '1 microsecond'), now())
               FROM sent s JOIN app.notifications n ON n.id=s.id AND n.recipient_user_id=$1
             ON CONFLICT (user_id, client_id, notification_id)
             DO UPDATE SET accepted_at=greatest(app.desktop_notification_receipts.accepted_at, excluded.accepted_at)
             RETURNING notification_id",
            &[&access.actor_user_id(), &body.events, &body.client, &versions],
        )
        .await?;
    let events: Vec<Uuid> = rows.iter().map(|row| row.get(0)).collect();
    cx.commit().await?;
    Ok((
        NO_STORE,
        Json(serde_json::json!({"account": access.actor_user_id(), "acknowledged": events})),
    ))
}

/// Gives the desktop app a fresh device token for its notifier. Registering again for the same
/// client replaces the old token. The token is shown once and only its hash is stored.
pub async fn register_notifier(
    State(data): State<Arc<Accounts>>,
    Extension(access): Extension<AccessContext>,
    Json(body): Json<Registration>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let cx = safety_core::db::DataContext::open(&data.platform.app, &access).await?;
    cx.db()
        .execute(
            "INSERT INTO app.desktop_notifier_devices(id, user_id, client_id, token_hash)
         VALUES ($1, $2, $3, encode(sha256(convert_to($4, 'UTF8')), 'hex'))
         ON CONFLICT (user_id, client_id)
         DO UPDATE SET token_hash=excluded.token_hash, created_at=now(), last_used_at=NULL",
            &[&Uuid::new_v4(), &access.actor_user_id(), &body.client, &token],
        )
        .await?;
    cx.commit().await?;
    Ok((NO_STORE, Json(serde_json::json!({"token": token}))))
}

/// Revokes the notifier's token, for example when the person signs out of the app.
pub async fn remove_notifier(
    State(data): State<Arc<Accounts>>,
    Extension(access): Extension<AccessContext>,
    Query(client): Query<Client>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let client = client
        .client
        .ok_or_else(|| ApiError::http(400, "A client ID is required"))?;
    let cx = safety_core::db::DataContext::open(&data.platform.app, &access).await?;
    cx.db()
        .execute(
            "DELETE FROM app.desktop_notifier_devices WHERE user_id=$1 AND client_id=$2",
            &[&access.actor_user_id(), &client],
        )
        .await?;
    cx.commit().await?;
    Ok((NO_STORE, Json(serde_json::json!({"removed": true}))))
}
