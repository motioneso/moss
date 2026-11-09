use crate::{
    config::Config,
    limit::SignInLimit,
    policy::{loopback, Policy},
};
use axum::{
    body::{to_bytes, Body},
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
    Extension, Json, Router,
};
use safety_core::{
    access::AccessContext,
    auth,
    db::DataContext,
    error::ApiError,
    http::{log, Platform},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{Mutex, Semaphore},
    time::timeout,
};

pub struct Network {
    pub platform: Arc<Platform>,
    pub policy: Policy,
    config: Mutex<Config>,
    config_path: PathBuf,
    setup: Mutex<()>,
    limits: Mutex<SignInLimit>,
    hashing: Semaphore,
}

impl Network {
    pub fn new(
        platform: Arc<Platform>,
        config: Config,
        path: PathBuf,
    ) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            policy: config.policy()?,
            platform,
            config: Mutex::new(config),
            config_path: path,
            setup: Mutex::new(()),
            limits: Mutex::new(SignInLimit::default()),
            hashing: Semaphore::new(4),
        }))
    }
}

/// `private` includes the shell, modules and their fallback. All routes run inside one guard.
/// Signed-in handlers receive the actor as an Extension; no browser-provided actor is accepted.
pub fn router(network: Arc<Network>, private: Router, web: PathBuf) -> Router {
    let auth_routes = auth::routes().with_state(network.platform.clone());
    let pages = Router::new()
        .route("/sign-in", get(|| async { Html(include_str!("../assets/sign-in.html")) }))
        .route("/setup", get(|| async { Html(include_str!("../assets/setup.html")) }))
        .route("/access.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], include_str!("../assets/access.js")) }))
        .route("/moss-start.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], "const app = await import('/app.js'); await app.default({module_or_path:'/app_bg.wasm'});") }))
        .route("/api/setup/status", get(setup_status))
        .route("/api/hello", get(|| async { Json(crate::instance::hello()) }))
        .route("/settings/sharing", get(|| async { Html(include_str!("../assets/sharing.html")) }))
        .route("/api/network", get(network_status).put(set_sharing))
        .route("/api/network/certificate", get(public_certificate))
        .with_state(network.clone());
    // Static theme assets are public. The middleware's closed allowlist decides which ones.
    let assets = Router::new()
        .nest_service(
            "/fonts",
            tower_http::services::ServeDir::new(web.join("fonts")),
        )
        .route_service(
            "/app.css",
            tower_http::services::ServeFile::new(web.join("app.css")),
        )
        .route_service(
            "/boot-theme.js",
            tower_http::services::ServeFile::new(web.join("boot-theme.js")),
        )
        .route_service(
            "/icon.svg",
            tower_http::services::ServeFile::new(web.join("icon.svg")),
        );
    private
        .merge(auth_routes)
        .merge(pages)
        .merge(assets)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(network, boundary))
}

fn theme_asset(path: &str) -> bool {
    matches!(path, "/app.css" | "/boot-theme.js" | "/icon.svg") || path.starts_with("/fonts/")
}

fn public(path: &str) -> bool {
    matches!(
        path,
        "/sign-in"
            | "/setup"
            | "/api/setup/status"
            | "/api/hello"
            | "/api/auth/sign-in/email"
            | "/api/auth/sign-up/email"
            | "/access.js"
            | "/app.css"
            | "/boot-theme.js"
            | "/icon.svg"
    ) || path.starts_with("/fonts/")
}

fn denied(status: u16, code: &'static str) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN),
        Json(json!({"code":code})),
    )
        .into_response()
}

async fn boundary(State(n): State<Arc<Network>>, mut request: Request, next: Next) -> Response {
    // The label is fixed; paths, queries, headers, bodies and response cookies are never logged.
    let cache = if theme_asset(request.uri().path()) {
        "private, max-age=3600"
    } else {
        "no-store"
    };
    let response = guarded(&n, &mut request, next).await;
    let mut response = response;
    let cache = if response.status().is_success() {
        cache
    } else {
        "no-store"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    log(audit_line(response.status().as_u16()));
    response
}

pub fn audit_line(status: u16) -> Value {
    json!({"event":"https_request", "status":status})
}

async fn guarded(n: &Arc<Network>, request: &mut Request, next: Next) -> Response {
    let Some(ConnectInfo(peer)) = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .copied()
    else {
        return denied(403, "peer_required");
    };
    if request.uri().authority().is_some() || request.uri().scheme().is_some() {
        return denied(421, "host_refused");
    }
    if let Err(status) = n
        .policy
        .check(request.headers(), request.method(), peer.ip())
    {
        return denied(
            status,
            if status == 421 {
                "host_refused"
            } else {
                "origin_or_sharing_refused"
            },
        );
    }
    let path = request.uri().path().to_owned();
    let signup = path == "/api/auth/sign-up/email";
    let signing_in = signup || path == "/api/auth/sign-in/email";
    let _permit = if signing_in {
        if !n.limits.lock().await.allow(peer.ip(), Instant::now()) {
            return limited();
        }
        // Bound body reads before taking scarce hashing slots or the owner-setup mutex.
        let body = std::mem::replace(request.body_mut(), Body::empty());
        let bytes = match timeout(Duration::from_secs(3), to_bytes(body, 16 * 1024)).await {
            Err(_) => return denied(408, "sign_in_body_timeout"),
            Ok(Err(_)) => return denied(413, "sign_in_body_too_large"),
            Ok(Ok(bytes)) => bytes,
        };
        *request.body_mut() = Body::from(bytes);
        match n.hashing.try_acquire() {
            Ok(p) => Some(p),
            Err(_) => return limited(),
        }
    } else {
        None
    };
    let _setup = if signup {
        if !loopback(peer.ip()) || !n.policy.local_authority(request.headers()) {
            return denied(403, "setup_is_local_only");
        }
        let guard = n.setup.lock().await;
        match owner_exists(&n.platform).await {
            Ok(false) => {}
            Ok(true) => return denied(403, "setup_is_complete"),
            Err(e) => return e.into_response(),
        }
        Some(guard)
    } else {
        None
    };
    if !public(&path) {
        match auth::resolve_access(&n.platform, request.headers()).await {
            Ok(access) => {
                request.extensions_mut().insert(access);
            }
            Err(ApiError::Unauthorized)
                if request.method() == Method::GET && !path.starts_with("/api/") =>
            {
                return Redirect::to("/sign-in").into_response()
            }
            Err(error) => return error.into_response(),
        }
    }
    let request = std::mem::replace(request, Request::new(Body::empty()));
    let response = next.run(request).await;
    if signing_in && response.status().is_success() {
        browser_auth_response(response).await
    } else {
        response
    }
}

fn limited() -> Response {
    let mut reply = denied(429, "sign_in_rate_limited");
    reply
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
    reply
}

/// Whitelist the browser response. The underlying parity routes also serve nonbrowser clients
/// and return a token in JSON; this entrypoint delivers it exclusively in HttpOnly Set-Cookie.
pub async fn browser_auth_response(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    let Ok(bytes) = to_bytes(body, 16 * 1024).await else {
        return denied(500, "invalid_auth_reply");
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return denied(500, "invalid_auth_reply");
    };
    let Some(user) = value.get("user").and_then(Value::as_object) else {
        return denied(500, "invalid_auth_reply");
    };
    let user: serde_json::Map<String, Value> = [
        "id",
        "email",
        "name",
        "emailVerified",
        "image",
        "createdAt",
        "updatedAt",
        "isInstanceAdmin",
    ]
    .into_iter()
    .filter_map(|k| user.get(k).map(|v| (k.to_owned(), v.clone())))
    .collect();
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(
        parts,
        Body::from(json!({"user":user, "redirect":false}).to_string()),
    )
}

async fn owner_exists(platform: &Platform) -> Result<bool, ApiError> {
    let access = AccessContext::new(uuid::Uuid::nil(), "local-setup-status");
    let cx = DataContext::open(&platform.app, &access).await?;
    let row = cx
        .db()
        .query_one(
            "SELECT EXISTS (SELECT 1 FROM app.list_all_users() WHERE is_bootstrap_owner)",
            &[],
        )
        .await?;
    let exists = row.get(0);
    cx.commit().await?;
    Ok(exists)
}

async fn setup_status(
    State(n): State<Arc<Network>>,
    Extension(ConnectInfo(peer)): Extension<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    // A remote visitor learns no installation state.
    if !loopback(peer.ip()) || !n.policy.local_authority(&headers) {
        return Err(ApiError::http(403, "Set up Moss on this computer first"));
    }
    Ok(Json(json!({"complete":owner_exists(&n.platform).await?})))
}

async fn require_admin(n: &Network, access: &AccessContext) -> Result<(), ApiError> {
    let cx = DataContext::open(&n.platform.app, access).await?;
    let row = cx
        .db()
        .query_one(
            "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
            &[&access.actor_user_id()],
        )
        .await?;
    let admin: bool = row.get(0);
    cx.commit().await?;
    if !admin {
        return Err(ApiError::http(
            403,
            "Only an administrator can change sharing",
        ));
    }
    Ok(())
}

async fn network_status(
    State(n): State<Arc<Network>>,
    Extension(access): Extension<AccessContext>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&n, &access).await?;
    let config = n.config.lock().await;
    let bytes = tokio::fs::read(&config.certificate)
        .await
        .map_err(|_| ApiError::http(500, "Cannot read the public certificate"))?;
    let leaf = crate::instance::leaf_der(&bytes)
        .map_err(|_| ApiError::http(500, "Invalid public certificate"))?;
    let fingerprint = crate::instance::fingerprint(&leaf);
    Ok(Json(
        json!({"sharing":n.policy.sharing(), "origins":config.origins, "fingerprint":fingerprint}),
    ))
}

async fn public_certificate(
    State(n): State<Arc<Network>>,
    Extension(access): Extension<AccessContext>,
) -> Result<Response, ApiError> {
    require_admin(&n, &access).await?;
    let config = n.config.lock().await;
    let bytes = tokio::fs::read(&config.certificate)
        .await
        .map_err(|_| ApiError::http(500, "Cannot read the public certificate"))?;
    let leaf = crate::instance::leaf_der(&bytes)
        .map_err(|_| ApiError::http(500, "Invalid public certificate"))?;
    // Return only the parsed public leaf, even if an operator supplied a combined PEM file.
    Ok((
        [
            (header::CONTENT_TYPE, "application/pkix-cert"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=moss-certificate.cer",
            ),
        ],
        leaf,
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sharing {
    sharing: bool,
}

async fn set_sharing(
    State(n): State<Arc<Network>>,
    Extension(access): Extension<AccessContext>,
    Json(body): Json<Sharing>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&n, &access).await?;
    let mut config = n.config.lock().await;
    let mut saved = config.clone();
    saved.sharing = body.sharing;
    saved
        .write(&n.config_path)
        .map_err(|_| ApiError::http(500, "Sharing was not saved. Try again."))?;
    n.policy.set_sharing(saved.sharing);
    *config = saved;
    Ok(Json(json!({"sharing":body.sharing})))
}
