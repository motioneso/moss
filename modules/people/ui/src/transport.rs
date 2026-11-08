use serde::de::DeserializeOwned;
use serde_json::{json, Value};

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = mossPeople, js_name = request)]
    fn bridge_request(method: &str, path: &str, body: &str) -> js_sys::Promise;
    #[wasm_bindgen(js_namespace = mossPeople, js_name = chat)]
    fn bridge_chat(text: &str) -> js_sys::Promise;
}

pub async fn request<T: DeserializeOwned>(method: &str, path: &str, body: Value) -> Result<T, ()> {
    #[cfg(target_arch = "wasm32")]
    {
        let reply =
            wasm_bindgen_futures::JsFuture::from(bridge_request(method, path, &body.to_string()))
                .await
                .map_err(|_| ())?;
        serde_json::from_str(&reply.as_string().ok_or(())?).map_err(|_| ())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (method, path, body);
        Err(())
    }
}
pub async fn get<T: DeserializeOwned>(path: &str) -> Result<T, ()> {
    request("GET", path, json!(null)).await
}
pub fn chat() {
    #[cfg(target_arch = "wasm32")]
    leptos::task::spawn_local(async {
        let _ =
            wasm_bindgen_futures::JsFuture::from(bridge_chat("Help me review my People matches."))
                .await;
    });
}
pub fn segment(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
