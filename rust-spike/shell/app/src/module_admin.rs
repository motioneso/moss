//! Lets an authenticated instance administrator manage signed modules through a one-shot
//! installer child. The supervisor supplies its database login for that child invocation;
//! management responses project catalog and operation records.
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use safety_core::{access::AccessContext, db::DataContext, http::Platform};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
};

pub const REGISTRY_FILE: &str = "registry.json";
const DATABASE_FOLDER: &str = "database";

pub struct Admin {
    pub platform: Arc<Platform>,
    pub instance: PathBuf,
    /// One install at a time; a second request waits.
    pub(crate) gate: tokio::sync::Mutex<()>,
    pub(crate) active: std::sync::Mutex<std::collections::BTreeSet<String>>,
}

impl Admin {
    pub fn new(platform: Arc<Platform>, instance: PathBuf) -> Self {
        Self {
            platform,
            instance,
            gate: tokio::sync::Mutex::new(()),
            active: Default::default(),
        }
    }
}

pub fn routes(admin: Arc<Admin>) -> Router {
    Router::new()
        .route("/api/modules", get(list))
        .route("/api/modules/plan", post(plan))
        .route("/api/modules/install", post(install))
        .merge(crate::module_management::routes())
        .merge(crate::module_updates::routes())
        .merge(crate::module_local::routes())
        .with_state(admin)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pick {
    module: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    approve: bool,
    /// The version the owner reviewed. An approved install must name it.
    #[serde(default)]
    version: Option<String>,
}

pub(crate) fn say(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub(crate) async fn require_admin(admin: &Admin, access: &AccessContext) -> Result<(), Response> {
    let refuse = || {
        say(
            StatusCode::FORBIDDEN,
            "Only the instance owner can manage modules",
        )
    };
    let cx = DataContext::open(&admin.platform.app, access)
        .await
        .map_err(|_| refuse())?;
    let row = cx
        .db()
        .query_opt(
            "SELECT is_instance_admin FROM app.get_user_by_id($1::uuid)",
            &[&access.actor_user_id()],
        )
        .await
        .map_err(|_| refuse())?;
    match row {
        Some(row) if row.get::<_, bool>(0) => Ok(()),
        _ => Err(refuse()),
    }
}

fn program(name: &str) -> Command {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    if cfg!(target_os = "linux") && dir.join("runtime").exists() {
        let mut command = Command::new(dir.join("moss-run"));
        command.arg(name);
        command
    } else {
        Command::new(dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
    }
}

/// The elevated database address, read fresh for one run.
pub(crate) fn elevated_url(instance: &Path) -> Result<String, &'static str> {
    // A gate points this at a stand-in; a real install always uses the bundled program.
    let mut supervisor = match std::env::var_os("MOSS_DB_PROGRAM") {
        Some(path) => Command::new(path),
        None => program("moss-db"),
    };
    let output = supervisor
        .args(["credentials", "--module-install", "--root"])
        .arg(instance.join(DATABASE_FOLDER))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "The database program is missing")?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "This instance cannot install modules")?;
    value["install_url"]
        .as_str()
        .filter(|u| !u.is_empty())
        .map(str::to_owned)
        .ok_or("This instance cannot install modules")
}

/// Runs the installer child and returns its output. Messages are short and never carry an address.
fn run(
    instance: &Path,
    registry: &crate::module_sources::Registry,
    extra: &[String],
    modules: &[String],
    actor: &str,
) -> Result<String, String> {
    let url = elevated_url(instance).map_err(str::to_owned)?;
    let exe = std::env::current_exe().map_err(|_| "Cannot find the installer".to_owned())?;
    let mut command = Command::new(exe);
    command
        .arg("install-module")
        .arg("--instance")
        .arg(instance)
        .args(["--registry-id", &registry.id])
        .args(["--actor", actor]);
    match (&registry.folder, &registry.url) {
        (Some(folder), None) => command.arg("--registry-folder").arg(folder),
        (None, Some(url)) => command.args(["--registry-url", url]),
        _ => return Err("The module registry settings are not valid".into()),
    };
    command
        .args(["--root-key", &registry.root_key])
        .args(["--first-party-key", &registry.first_party_key])
        .args(extra)
        .args(modules)
        .env(crate::module_install::INSTALL_URL_VARIABLE, url)
        .stdin(Stdio::null());
    let output = command
        .output()
        .map_err(|_| "Cannot start the installer".to_owned())?;
    if output.status.success() {
        return String::from_utf8(output.stdout).map_err(|_| "Unreadable installer output".into());
    }
    let text = String::from_utf8_lossy(&output.stderr);
    let line = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty() && !l.contains("postgres://"))
        .unwrap_or("The installer failed");
    Err(line
        .trim_start_matches("moss-shell: ")
        .chars()
        .take(300)
        .collect())
}

pub(crate) fn run_json(
    instance: &Path,
    registry: &crate::module_sources::Registry,
    extra: &[String],
    modules: &[String],
    actor: &str,
) -> Result<Value, String> {
    let text = run(instance, registry, extra, modules, actor)?;
    // Legacy installs print a human result; read-only calls and operations print JSON.
    Ok(serde_json::from_str(text.lines().last().unwrap_or("")).unwrap_or(json!({"ok":true})))
}

async fn call(
    admin: Arc<Admin>,
    access: AccessContext,
    source: Option<String>,
    extra: Vec<String>,
    modules: Vec<String>,
) -> Response {
    let _one_at_a_time = admin.gate.lock().await;
    if let Err(response) = require_admin(&admin, &access).await {
        return response;
    }
    let registry = match crate::module_sources::select(&admin.instance, source.as_deref()) {
        Ok(registry) => registry,
        Err(_) => {
            return say(
                StatusCode::BAD_REQUEST,
                "The source registry is not configured",
            )
        }
    };
    let instance = admin.instance.clone();
    let actor = access.actor_user_id().to_string();
    match tokio::task::spawn_blocking(move || {
        run_json(&instance, &registry, &extra, &modules, &actor)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(message)) => say(StatusCode::UNPROCESSABLE_ENTITY, &message),
        Err(_) => say(StatusCode::INTERNAL_SERVER_ERROR, "The installer stopped"),
    }
}

async fn list(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
) -> Response {
    if let Err(refused) = require_admin(&admin, &access).await {
        return refused;
    }
    call(admin, access, None, vec!["--list".into()], vec![]).await
}

pub(crate) fn valid_name(name: &str) -> bool {
    name.bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphanumeric())
        && name.len() <= 100
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_')
}

async fn plan(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(pick): Json<Pick>,
) -> Response {
    if let Err(refused) = require_admin(&admin, &access).await {
        return refused;
    }
    if !valid_name(&pick.module) {
        return say(StatusCode::BAD_REQUEST, "Invalid module name");
    }
    call(
        admin,
        access,
        pick.source,
        vec!["--plan".into()],
        vec![pick.module],
    )
    .await
}

/// Without `approve` the installer refuses a module that asks for permissions, so the owner
/// always sees them (through the plan call) before anything is installed.
async fn install(
    State(admin): State<Arc<Admin>>,
    Extension(access): Extension<AccessContext>,
    Json(pick): Json<Pick>,
) -> Response {
    if let Err(refused) = require_admin(&admin, &access).await {
        return refused;
    }
    if !valid_name(&pick.module) {
        return say(StatusCode::BAD_REQUEST, "Invalid module name");
    }
    let mut extra: Vec<String> = vec![];
    if pick.approve {
        // Approval covers only the version that was previewed.
        let Some(version) = pick.version.as_deref().filter(|v| valid_name(v)) else {
            return say(StatusCode::BAD_REQUEST, "Name the version you reviewed");
        };
        extra.extend([
            "--approve".to_owned(),
            "--version".to_owned(),
            version.to_owned(),
        ]);
    }
    call(admin, access, pick.source, extra, vec![pick.module]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_names_cannot_smuggle_options() {
        assert!(valid_name("people"));
        assert!(valid_name("acme.notes-2"));
        assert!(!valid_name("--approve"));
        assert!(!valid_name("-x"));
        assert!(!valid_name(""));
        assert!(!valid_name("a b"));
    }
}
