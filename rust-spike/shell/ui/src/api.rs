//! Calls to the Moss server. Same origin in the browser and in the desktop window.

use gloo_net::http::Request;
use moss_shell_contract::{ChatThread, SendMessage, ShellView, TodayView};
use serde::de::DeserializeOwned;

async fn get<T: DeserializeOwned>(path: &str) -> Result<T, String> {
    let response = Request::get(path).send().await.map_err(|e| e.to_string())?;
    if !response.ok() {
        if response.status() == 401 {
            if let Some(window) = web_sys::window() {
                let _ = window.location().set_href("/sign-in");
            }
        }
        return Err(format!("{path} answered {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

pub async fn shell() -> Result<ShellView, String> {
    get("/api/shell").await
}

/// One navigation entry offered by an installed module.
#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct ModuleNav {
    pub module: String,
    pub label: String,
    pub path: String,
    pub icon: String,
}

#[derive(serde::Deserialize)]
struct ModuleNavList {
    links: Vec<ModuleNav>,
}

/// Installed modules' navigation. A failure means no module links, never a broken app.
pub async fn module_navigation() -> Vec<ModuleNav> {
    get::<ModuleNavList>("/api/modules/navigation")
        .await
        .map(|l| l.links)
        .unwrap_or_default()
}

pub async fn today() -> Result<TodayView, String> {
    get("/api/today").await
}

/// One forecast day from the Weather package.
#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct WeatherDay {
    pub high: i64,
    pub low: i64,
}

/// The current reading from the Weather package.
#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct WeatherToday {
    /// Today's own range, when the package has one. The forecast list starts tomorrow.
    #[serde(default)]
    pub today: Option<WeatherDay>,
    pub temp: i64,
    pub condition: String,
    pub icon: String,
    pub unit: String,
    #[serde(default)]
    pub forecast: Vec<WeatherDay>,
}

#[derive(serde::Deserialize)]
struct WeatherTodayReply {
    data: Option<WeatherToday>,
}

/// Today's weather for the signed-in person, or none when the package has no reading.
pub async fn weather_today() -> Result<Option<WeatherToday>, String> {
    get::<WeatherTodayReply>("/api/m/weather/today")
        .await
        .map(|r| r.data)
}

/// True when the Briefings package is installed and answers for the signed-in person.
pub async fn briefings_available() -> bool {
    get::<serde_json::Value>("/api/m/briefings/definitions")
        .await
        .is_ok()
}

pub async fn chat_thread() -> Result<ChatThread, String> {
    get("/api/chat/thread").await
}

/// Starts a turn. The reply arrives in the thread, which the drawer polls.
pub async fn send_message(text: String) -> Result<ChatThread, String> {
    let response = Request::post("/api/chat/messages")
        .json(&SendMessage {
            text,
            ..Default::default()
        })
        .map_err(|e| e.to_string())?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == 409 {
        return Err("busy".into());
    }
    if !response.ok() {
        return Err(format!("send answered {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct AvailableModule {
    pub id: String,
    pub version: String,
    pub changelog: String,
    pub installed: bool,
}

#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct ModuleList {
    pub modules: Vec<AvailableModule>,
}

#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct PlannedPermission {
    pub headline: String,
    pub details: Vec<String>,
}

#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct ModulePlan {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub permissions: Vec<PlannedPermission>,
}

#[derive(serde::Serialize)]
struct Pick<'a> {
    module: &'a str,
    approve: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<&'a str>,
}

/// The server's own sentence when it refuses, else a plain fallback.
async fn failure(response: gloo_net::http::Response) -> String {
    if response.status() == 401 {
        if let Some(window) = web_sys::window() {
            let _ = window.location().set_href("/sign-in");
        }
    }
    match response.json::<serde_json::Value>().await {
        Ok(v) => v["error"]
            .as_str()
            .unwrap_or("The server could not do that")
            .to_owned(),
        Err(_) => "The server could not do that".to_owned(),
    }
}

async fn post_pick<T: DeserializeOwned>(
    path: &str,
    module: &str,
    approve: bool,
    version: Option<&str>,
) -> Result<T, String> {
    let response = Request::post(path)
        .json(&Pick {
            module,
            approve,
            version,
        })
        .map_err(|e| e.to_string())?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.ok() {
        return Err(failure(response).await);
    }
    response.json().await.map_err(|e| e.to_string())
}

pub async fn available_modules() -> Result<ModuleList, String> {
    let response = Request::get("/api/modules")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.ok() {
        return Err(failure(response).await);
    }
    response.json().await.map_err(|e| e.to_string())
}

pub async fn module_plan(module: &str) -> Result<ModulePlan, String> {
    post_pick("/api/modules/plan", module, false, None).await
}

pub async fn install_module(module: &str, version: &str) -> Result<(), String> {
    post_pick::<serde_json::Value>("/api/modules/install", module, true, Some(version))
        .await
        .map(|_| ())
}

#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct RefreshAccount {
    pub status: String,
}

#[derive(serde::Deserialize, Clone, PartialEq)]
pub struct RefreshState {
    #[serde(rename = "refreshId")]
    pub refresh_id: String,
    pub status: String,
    #[serde(default)]
    pub accounts: Vec<RefreshAccount>,
}

#[derive(serde::Deserialize)]
struct RefreshStarted {
    #[serde(rename = "refreshId")]
    refresh_id: String,
}

#[derive(serde::Deserialize)]
struct ConnectorAccount {
    #[serde(rename = "providerId")]
    provider_id: String,
    status: String,
}

#[derive(serde::Deserialize)]
struct ConnectorAccountList {
    accounts: Vec<ConnectorAccount>,
}

/// True when the signed-in person has a live Google or IMAP mail account.
/// A failure reads as false, so the control stays hidden.
pub async fn has_mail_account() -> bool {
    get::<ConnectorAccountList>("/api/connectors/accounts")
        .await
        .map(|list| {
            list.accounts.iter().any(|a| {
                a.status == "active"
                    && (a.provider_id == "google" || a.provider_id.starts_with("imap-"))
            })
        })
        .unwrap_or(false)
}

/// Starts a refresh. The same key returns the same refresh, so a second click joins it.
pub async fn start_email_refresh(key: &str) -> Result<String, String> {
    let response = Request::post("/api/connectors/email-refresh")
        .json(&serde_json::json!({ "idempotencyKey": key }))
        .map_err(|e| e.to_string())?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.ok() {
        return Err(failure(response).await);
    }
    response
        .json::<RefreshStarted>()
        .await
        .map(|s| s.refresh_id)
        .map_err(|e| e.to_string())
}

pub async fn email_refresh_state(id: &str) -> Result<RefreshState, String> {
    get(&format!("/api/connectors/email-refresh/{id}")).await
}

/// The package owns shortcut settings; the shell only listens for the chosen combination.
pub async fn scratchpad_shortcut() -> Option<String> {
    get::<serde_json::Value>("/api/m/scratchpad/note")
        .await
        .ok()?
        .get("shortcut")?
        .as_str()
        .map(str::to_owned)
}
