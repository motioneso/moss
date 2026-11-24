//! Same-origin catalog API. Account identity is always supplied by the session cookie.
use gloo_net::http::Request;
use moss_shell_contract::catalog_view::CatalogView;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
pub async fn read() -> Result<CatalogView, String> {
    crate::api::get_json("/api/modules/catalog-view").await
}
pub async fn post<T: DeserializeOwned>(path: &str, body: Value) -> Result<T, String> {
    let response = Request::post(path)
        .json(&body)
        .map_err(|_| "Choice could not be saved")?
        .send()
        .await
        .map_err(|_| "Connection unavailable")?;
    if !response.ok() {
        return Err(response
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v["error"].as_str().map(str::to_owned))
            .unwrap_or("Choice could not be saved".into()));
    }
    response
        .json()
        .await
        .map_err(|_| "Reply could not be read".into())
}
pub async fn switch(module: &str, server: bool, enabled: bool) -> Result<(), String> {
    post::<Value>(
        &format!(
            "/api/modules/{module}/{}-switch",
            if server { "server" } else { "account" }
        ),
        json!({"enabled":enabled}),
    )
    .await
    .map(|_| ())
}
pub fn query(name: &str) -> Option<String> {
    let search = web_sys::window()?.location().search().ok()?;
    search.trim_start_matches('?').split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name)
            .then(|| {
                js_sys::decode_uri_component(value)
                    .ok()
                    .and_then(|s| s.as_string())
            })
            .flatten()
    })
}
pub fn detail_url(id: &str, source: &str) -> String {
    format!(
        "/settings/modules?module={}&source={}",
        js_sys::encode_uri_component(id),
        js_sys::encode_uri_component(source)
    )
}
