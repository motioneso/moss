//! The proactive card routes and the usefulness feedback routes.
//!
//! The host serves these itself. Each request opens a data context as the signed-in person, runs
//! one handler from the module host library, and commits only when the handler succeeded.
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    response::Response,
    routing::{get, patch, post},
    Extension, Router,
};
use moss_module_host::{proactive_cards, usefulness_feedback};
use safety_core::{
    access::AccessContext,
    db::{DataContext, Database},
    error::{json_reply, ApiError},
};
use serde_json::Value;
use std::{future::Future, sync::Arc};

/// Scanner sources this server can run. None are wired yet, so a refresh enqueues nothing.
pub struct Feedback {
    database: Database,
    registered: Vec<String>,
}

impl Feedback {
    pub fn new(database: Database) -> Self {
        Self { database, registered: Vec::new() }
    }
}

pub fn routes(state: Arc<Feedback>) -> Router {
    Router::new()
        .route("/api/me/proactive-cards", get(cards))
        .route("/api/me/proactive-cards/refresh", post(refresh))
        .route("/api/me/usefulness-feedback", get(list).post(create))
        .route("/api/me/usefulness-feedback/signals", post(signal))
        .route("/api/me/usefulness-feedback/:id/undo", post(undo))
        .route("/api/me/usefulness-feedback/:id", patch(edit))
        .with_state(state)
}

/// Runs one handler inside the person's own data context and commits only on success.
macro_rules! run {
    ($state:expr, $access:expr, |$cx:ident| $call:expr) => {{
        let outcome = async {
            let opened = DataContext::open(&$state.database, &$access).await?;
            let reply = {
                let $cx = &opened;
                $call.await?
            };
            opened.commit().await?;
            Ok::<_, ApiError>(reply)
        }
        .await;
        reply(outcome)
    }};
}

fn reply(outcome: Result<(u16, Value), ApiError>) -> Response {
    match outcome {
        Ok((status, body)) => json_reply(status, &body),
        Err(error) => axum::response::IntoResponse::into_response(error),
    }
}

fn body_value(bytes: &Bytes) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

async fn cards(
    State(state): State<Arc<Feedback>>,
    Extension(access): Extension<AccessContext>,
    Query(query): Query<Vec<(String, String)>>,
) -> Response {
    let limit = query.iter().find(|(k, _)| k == "limit").map(|(_, v)| v.clone());
    run!(state, access, |cx| proactive_cards::list(cx, limit.as_deref()))
}

async fn refresh(State(state): State<Arc<Feedback>>, Extension(access): Extension<AccessContext>) -> Response {
    let registered = state.registered.clone();
    run!(state, access, |cx| proactive_cards::refresh(cx, &registered))
}

async fn create(State(state): State<Arc<Feedback>>, Extension(access): Extension<AccessContext>, body: Bytes) -> Response {
    let body = body_value(&body);
    run!(state, access, |cx| usefulness_feedback::create(cx, &body))
}

async fn signal(State(state): State<Arc<Feedback>>, Extension(access): Extension<AccessContext>, body: Bytes) -> Response {
    let body = body_value(&body);
    run!(state, access, |cx| usefulness_feedback::signal(cx, &body))
}

async fn list(
    State(state): State<Arc<Feedback>>,
    Extension(access): Extension<AccessContext>,
    Query(query): Query<Vec<(String, String)>>,
) -> Response {
    run!(state, access, |cx| usefulness_feedback::list(cx, &query))
}

async fn undo(
    State(state): State<Arc<Feedback>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
) -> Response {
    run!(state, access, |cx| usefulness_feedback::undo(cx, &id))
}

async fn edit(
    State(state): State<Arc<Feedback>>,
    Extension(access): Extension<AccessContext>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let body = body_value(&body);
    run!(state, access, |cx| usefulness_feedback::update_reason(cx, &id, &body))
}
