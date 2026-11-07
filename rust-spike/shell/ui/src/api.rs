//! Calls to the Moss server. Same origin in the browser and in the desktop window.

use gloo_net::http::Request;
use moss_shell_contract::{ChatMessage, ChatThread, SendMessage, ShellView, TodayView};
use serde::de::DeserializeOwned;

async fn get<T: DeserializeOwned>(path: &str) -> Result<T, String> {
    let response = Request::get(path).send().await.map_err(|e| e.to_string())?;
    if !response.ok() {
        return Err(format!("{path} answered {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

pub async fn shell() -> Result<ShellView, String> {
    get("/api/shell").await
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
