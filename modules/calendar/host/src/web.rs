//! Calendar's installed screens and routes behind the existing Rust authentication boundary.
//! Only verified static package code is public; account data goes through Network's guard.
use axum::{
    extract::{ConnectInfo, OriginalUri, Path, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{any, get},
    Extension, Json, Router,
};
use moss_module_host::{application::Application, frame::AssetPolicy};
use moss_network::web::Network;
use safety_core::access::AccessContext;
use serde_json::Value;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;

struct Screens {
    app: Arc<Application>,
    network: Arc<Network>,
    origins: Vec<String>,
    blocking: Arc<Semaphore>,
}

/// Consume an already opened application and its configured HTTPS origins. The caller owns
/// migration/bootstrap, registry installation, TLS listening and graceful shutdown.
/// This router is Calendar-only; the full shell/chat composition remains separate.
pub fn router(
    app: Arc<Application>,
    network: Arc<Network>,
    origins: Vec<String>,
    shared: PathBuf,
) -> anyhow::Result<Router> {
    anyhow::ensure!(!origins.is_empty(), "Configured HTTPS origins required");
    for origin in &origins {
        anyhow::ensure!(origin.starts_with("https://"), "HTTPS required");
        AssetPolicy::new(origin)?;
    }
    let state = Arc::new(Screens {
        app,
        network: network.clone(),
        origins,
        blocking: Arc::new(Semaphore::new(8)),
    });
    // These files contain no account data. An opaque module document cannot send the
    // parent session cookie, and must receive its own sandbox/CORS headers unchanged.
    let assets = Router::new()
        .route("/module-ui/calendar/{digest}/{*file}", get(package_asset))
        .nest_service(
            "/module-shared",
            tower_http::services::ServeDir::new(&shared),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            static_boundary,
        ))
        .with_state(state.clone());
    let private = Router::new()
        .route("/", get(|| async { Redirect::to("/calendar") }))
        .route("/today", get(|| async { Redirect::to("/calendar") }))
        .route("/calendar", get(screen))
        .route("/settings/calendar", get(screen))
        .route(
            "/calendar-host.mjs",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript")],
                    include_str!("../web/parent.mjs"),
                )
            }),
        )
        .route(
            "/calendar-host.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css")],
                    include_str!("../web/layout.css"),
                )
            }),
        )
        .route(
            "/calendar-bridge.mjs",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript")],
                    include_str!("../../../../rust-spike/module-ui/web/host-bridge.mjs"),
                )
            }),
        )
        .route("/api/calendar/events", get(dispatch))
        .route("/api/calendar/events/{id}", get(dispatch))
        .route(
            "/api/calendar/briefing-settings",
            get(dispatch).patch(dispatch),
        )
        .route("/api/m/calendar/{*path}", any(dispatch))
        .with_state(state);
    Ok(moss_network::web::router(network, private, shared).merge(assets))
}

async fn static_boundary(
    State(state): State<Arc<Screens>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(ConnectInfo(peer)) = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .copied()
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if request.uri().scheme().is_some() || request.uri().authority().is_some() {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    if let Err(status) = check_static(
        &state.network.policy,
        request.headers(),
        request.method(),
        peer,
    ) {
        return StatusCode::from_u16(status).unwrap().into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("null"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    // Also sandbox direct navigation to shared files (normally just CSS/fonts).
    if !response
        .headers()
        .contains_key(header::CONTENT_SECURITY_POLICY)
    {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'none'; sandbox allow-scripts; frame-ancestors 'self'",
            ),
        );
    }
    response
}

fn check_static(
    policy: &moss_network::policy::Policy,
    headers: &HeaderMap,
    method: &Method,
    peer: SocketAddr,
) -> Result<(), u16> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return Err(405);
    }
    let mut checked = headers.clone();
    let mut origins = headers.get_all(header::ORIGIN).iter();
    let first = origins.next();
    // Opaque-frame scripts send Origin: null; no-CORS stylesheet requests omit it.
    // Both fetch only public static code here. Keep explicit foreign origins rejected.
    if first.is_none() || (first.is_some_and(|v| v == "null") && origins.next().is_none()) {
        checked.remove(header::ORIGIN);
        checked.remove("sec-fetch-site");
    }
    policy.check(&checked, method, peer.ip())
}

async fn package_asset(
    State(state): State<Arc<Screens>>,
    headers: HeaderMap,
    Path((digest, file)): Path<(String, String)>,
) -> Response {
    let Some(origin) = state.origins.iter().find(|o| {
        headers
            .get(header::HOST)
            .is_some_and(|h| h == o.trim_start_matches("https://"))
    }) else {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    };
    let policy = match AssetPolicy::new(origin) {
        Ok(p) => p,
        Err(_) => return unavailable(),
    };
    let Ok(permit) = state.blocking.clone().try_acquire_owned() else {
        return unavailable();
    };
    let app = state.app.clone();
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        app.installer.ui_asset("calendar", &digest, &file, &policy)
    })
    .await
    {
        Ok(Ok(asset)) => {
            let mut response =
                ([(header::CONTENT_TYPE, asset.content_type)], asset.body).into_response();
            for (key, value) in asset.headers {
                if let (Ok(key), Ok(value)) = (
                    key.parse::<header::HeaderName>(),
                    value.parse::<HeaderValue>(),
                ) {
                    response.headers_mut().insert(key, value);
                }
            }
            response
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn screen(
    State(state): State<Arc<Screens>>,
    Extension(access): Extension<AccessContext>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let path = uri.path().to_owned();
    // Keep event deep links when retrying, escaping the untrusted query for HTML.
    let reload = uri
        .to_string()
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let Ok(permit) = state.blocking.clone().try_acquire_owned() else {
        return unavailable();
    };
    let app = state.app.clone();
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        app.installer.screen(&access, "calendar", &path)
    }).await {
        Ok(Ok(screen)) => {
            // The installer constructs src from validated identifiers/digest/relative paths.
            let src = screen.src.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
            Html(format!(r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendar · Moss</title><link rel="stylesheet" href="/module-shared/park-press.css"><link rel="stylesheet" href="/calendar-host.css"></head><body><nav aria-label="Moss"><a href="/calendar">Calendar</a><a href="/settings/calendar">Calendar settings</a><a href="/settings/sharing">Device access</a><a class="jds-btn jds-btn--secondary" href="{reload}">Reload page</a><button type="button" id="sign-out" class="jds-btn jds-btn--secondary">Sign out</button></nav><p id="host-error" role="alert" hidden></p><iframe id="calendar" title="Calendar" sandbox="allow-scripts" data-src="{src}"></iframe><script type="module" src="/calendar-host.mjs"></script></body></html>"#)).into_response()
        }
        _ => (StatusCode::SERVICE_UNAVAILABLE, Html("<p>Calendar could not load. Check that its package is installed and enabled, then reload.</p>")).into_response(),
    }
}

async fn dispatch(
    State(state): State<Arc<Screens>>,
    Extension(access): Extension<AccessContext>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    body: axum::body::Bytes,
) -> Response {
    let body = if body.is_empty() {
        "null"
    } else {
        match std::str::from_utf8(&body) {
            Ok(s) => s,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        }
    };
    if serde_json::from_str::<Value>(body).is_err() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let body = body.to_owned();
    let path = uri
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or(uri.path())
        .to_owned();
    // Only the event reads and briefing-settings routes above enter through the legacy prefix.
    // They still use the installed manifest, account enablement and per-call transaction.
    let path = if let Some(rest) = path.strip_prefix("/api/calendar/") {
        format!("/api/m/calendar/{rest}")
    } else {
        path
    };
    let Ok(permit) = state.blocking.clone().try_acquire_owned() else {
        return unavailable();
    };
    let app = state.app.clone();
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let result = app.dispatch_extended(access, method.as_str(), &path, &body)?;
        serde_json::from_str::<Value>(&result).map_err(anyhow::Error::from)
    })
    .await
    {
        Ok(Ok(value)) => {
            let status = value["status"]
                .as_u64()
                .and_then(|s| u16::try_from(s).ok())
                .and_then(|s| StatusCode::from_u16(s).ok())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (status, Json(value["body"].clone())).into_response()
        }
        _ => unavailable(),
    }
}
fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({"error":"Calendar is unavailable. Please retry."})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opaque_static_access_keeps_host_sharing_and_method_checks() {
        let policy = moss_network::policy::Policy::new(&["https://localhost:5180"], false).unwrap();
        let peer = "127.0.0.1:1234".parse().unwrap();
        let h: HeaderMap = [
            ("host", "localhost:5180"),
            ("origin", "null"),
            ("sec-fetch-site", "cross-site"),
        ]
        .into_iter()
        .map(|(k, v)| (k.parse::<header::HeaderName>().unwrap(), v.parse().unwrap()))
        .collect();
        assert_eq!(check_static(&policy, &h, &Method::GET, peer), Ok(()));
        // Browsers omit Origin on no-CORS stylesheet requests from opaque frames.
        let mut stylesheet = h.clone();
        stylesheet.remove(header::ORIGIN);
        assert_eq!(
            check_static(&policy, &stylesheet, &Method::GET, peer),
            Ok(())
        );
        assert_eq!(
            check_static(&policy, &stylesheet, &Method::POST, peer),
            Err(405)
        );
        assert_eq!(
            check_static(
                &policy,
                &stylesheet,
                &Method::GET,
                "192.0.2.1:1234".parse().unwrap()
            ),
            Err(403)
        );
        stylesheet.insert(header::HOST, "evil.example".parse().unwrap());
        assert_eq!(
            check_static(&policy, &stylesheet, &Method::GET, peer),
            Err(421)
        );
        assert_eq!(check_static(&policy, &h, &Method::POST, peer), Err(405));
        assert_eq!(
            check_static(&policy, &h, &Method::GET, "192.0.2.1:1234".parse().unwrap()),
            Err(403)
        );
        for (key, value) in [("host", "evil.example"), ("origin", "https://evil.example")] {
            let mut bad = h.clone();
            bad.insert(
                key.parse::<header::HeaderName>().unwrap(),
                value.parse().unwrap(),
            );
            assert!(check_static(&policy, &bad, &Method::GET, peer).is_err());
        }
        let mut duplicate = h.clone();
        duplicate.append(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert_eq!(
            check_static(&policy, &duplicate, &Method::GET, peer),
            Err(403)
        );
    }
}
