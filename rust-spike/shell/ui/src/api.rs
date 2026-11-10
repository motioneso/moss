//! Calls to the Moss server. Same origin in the browser and in the desktop window.

use gloo_net::http::Request;
use moss_shell_contract::{ChatMessage, ChatThread, SendMessage, ShellView, TodayView};
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

pub async fn chat_thread() -> Result<ChatThread, String> {
    get("/api/chat/thread").await
}

pub async fn send_message(text: String) -> Result<ChatMessage, String> {
    let response = Request::post("/api/chat/messages")
        .json(&SendMessage { text })
        .map_err(|e| e.to_string())?
        .send()
        .await
        .map_err(|e| e.to_string())?;
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

async fn post_pick<T: DeserializeOwned>(path: &str, module: &str, approve: bool, version: Option<&str>) -> Result<T, String> {
    let response = Request::post(path)
        .json(&Pick { module, approve, version })
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
