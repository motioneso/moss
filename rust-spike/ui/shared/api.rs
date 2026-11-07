//! The same-origin calls to the Rust Tasks server. Spike sign-in: seed user A's bearer token.

use gloo_net::http::Request;
use serde::Deserialize;
use serde_json::json;

use crate::model::{List, Task};

const AUTH: &str = "Bearer 40000000-0000-4000-8000-000000000001";

fn failed(error: impl std::fmt::Display) -> String {
    error.to_string()
}

async fn check(response: gloo_net::http::Response) -> Result<gloo_net::http::Response, String> {
    if response.ok() {
        return Ok(response);
    }
    Err(format!("{} {}", response.status(), response.text().await.unwrap_or_default()))
}

pub async fn list_tasks() -> Result<Vec<Task>, String> {
    #[derive(Deserialize)]
    struct Reply {
        tasks: Vec<Task>,
    }
    let response = Request::get("/api/tasks").header("authorization", AUTH).send().await.map_err(failed)?;
    Ok(check(response).await?.json::<Reply>().await.map_err(failed)?.tasks)
}

pub async fn list_lists() -> Result<Vec<List>, String> {
    #[derive(Deserialize)]
    struct Reply {
        lists: Vec<List>,
    }
    let response =
        Request::get("/api/tasks/lists").header("authorization", AUTH).send().await.map_err(failed)?;
    Ok(check(response).await?.json::<Reply>().await.map_err(failed)?.lists)
}

pub async fn create_task(title: &str) -> Result<(), String> {
    let request = Request::post("/api/tasks")
        .header("authorization", AUTH)
        .json(&json!({ "title": title }))
        .map_err(failed)?;
    check(request.send().await.map_err(failed)?).await.map(|_| ())
}

pub async fn set_done(id: &str, done: bool) -> Result<(), String> {
    let status = if done { "done" } else { "todo" };
    let request = Request::patch(&format!("/api/tasks/{id}"))
        .header("authorization", AUTH)
        .json(&json!({ "status": status }))
        .map_err(failed)?;
    check(request.send().await.map_err(failed)?).await.map(|_| ())
}
