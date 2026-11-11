use crate::{google::{GoogleConnect, Phase}, model, views::AccountList};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Button, ButtonVariant, EmptyState, Masthead};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace=connectorsBridge, js_name=request)]
    fn bridge_request(method: &str, path: &str, body: &str) -> js_sys::Promise;
}

/// Like `request`, but keeps the server's status and message for a refused step.
async fn attempt(method: &str, path: &str, body: Value) -> Result<Value, (u16, String)> {
    let result = JsFuture::from(bridge_request(method, path, &body.to_string()))
        .await
        .map_err(|e| {
            let text = js_sys::JSON::stringify(&e).ok().and_then(|s| s.as_string()).unwrap_or_default();
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let status = parsed["status"].as_u64().unwrap_or(0) as u16;
            let message = parsed["error"].as_str().or(parsed["message"].as_str()).unwrap_or("").to_string();
            (status, message)
        })?;
    serde_json::from_str(&result.as_string().unwrap_or_default()).map_err(|_| (0, String::new()))
}

async fn request(method: &str, path: &str, body: Value) -> Result<Value, ()> {
    let result = JsFuture::from(bridge_request(method, path, &body.to_string()))
        .await
        .map_err(|_| ())?;
    serde_json::from_str(&result.as_string().ok_or(())?).map_err(|_| ())
}

/// Accounts with each one's saved Email and Calendar choices.
async fn load() -> Result<Vec<(Value, Value)>, ()> {
    let listed = request("GET", "/accounts", Value::Null).await?;
    let mut rows = Vec::new();
    for account in listed["accounts"].as_array().ok_or(())? {
        let path = format!("/accounts/{}/feature-grants", account["id"].as_str().ok_or(())?);
        let grants = request("GET", &path, Value::Null).await?;
        rows.push((account.clone(), grants));
    }
    Ok(rows)
}

#[component]
pub fn Connections() -> impl IntoView {
    let rows = RwSignal::new(None::<Vec<(Value, Value)>>);
    let failed = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let refresh = move || {
        spawn_local(async move {
            match load().await {
                Ok(next) => {
                    failed.set(false);
                    rows.set(Some(next));
                }
                Err(()) => failed.set(true),
            }
        });
    };
    refresh();
    let on_switch = Callback::new(move |(id, feature, on): (String, String, bool)| {
        busy.set(true);
        spawn_local(async move {
            let body = json!({ feature: on });
            if request("PUT", &format!("/accounts/{id}/feature-grants"), body).await.is_err() {
                failed.set(true);
            }
            busy.set(false);
            refresh();
        });
    });
    let on_revoke = Callback::new(move |id: String| {
        busy.set(true);
        spawn_local(async move {
            if request("POST", &format!("/accounts/{id}/revoke"), json!({})).await.is_err() {
                failed.set(true);
            }
            busy.set(false);
            refresh();
        });
    });
    let phase = RwSignal::new(Phase::Credentials);
    let show_google = RwSignal::new(false);
    let client_id = RwSignal::new(String::new());
    let client_secret = RwSignal::new(String::new());
    let redirect = RwSignal::new(String::new());
    let google_error = RwSignal::new(None::<String>);
    let done = RwSignal::new(false);
    let reset = move || {
        phase.set(Phase::Credentials);
        show_google.set(false);
        client_secret.set(String::new());
        redirect.set(String::new());
    };
    // The popup opens inside the click so the browser does not block it.
    let on_open = Callback::new(move |_| {
        let popup = web_sys::window().and_then(|w| w.open_with_url_and_target("about:blank", "_blank").ok().flatten());
        busy.set(true);
        google_error.set(None);
        spawn_local(async move {
            let body = json!({"clientId": client_id.get_untracked().trim(), "clientSecret": client_secret.get_untracked().trim()});
            match attempt("POST", "/google/authorize", body).await {
                Ok(answer) => {
                    let url = answer["authUrl"].as_str().unwrap_or("").to_string();
                    match popup {
                        Some(win) => { let _ = win.location().set_href(&url); }
                        None => google_error.set(Some("Your browser blocked the consent window. Allow pop-ups for this page and try again.".into())),
                    }
                    phase.set(Phase::Redirect);
                }
                Err((status, message)) => {
                    if let Some(win) = popup { let _ = win.close(); }
                    google_error.set(Some(model::google_error_text(status, &message)));
                }
            }
            busy.set(false);
        });
    });
    let on_finish = Callback::new(move |_| {
        busy.set(true);
        google_error.set(None);
        spawn_local(async move {
            let body = json!({"redirectUrl": redirect.get_untracked().trim()});
            match attempt("POST", "/google/complete", body).await {
                Ok(_) => {
                    reset();
                    done.set(true);
                    refresh();
                }
                Err((status, message)) => google_error.set(Some(model::google_error_text(status, &message))),
            }
            busy.set(false);
        });
    });
    let on_cancel = Callback::new(move |_| { google_error.set(None); reset(); });
    let on_file = Callback::new(move |_| {
        let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return };
        let Ok(el) = doc.create_element("input") else { return };
        let _ = el.set_attribute("type", "file");
        let _ = el.set_attribute("accept", ".json,application/json");
        let input: web_sys::HtmlInputElement = el.unchecked_into();
        let picked = input.clone();
        let onchange = Closure::once_into_js(move || {
            let Some(file) = picked.files().and_then(|f| f.get(0)) else { return };
            spawn_local(async move {
                let text = JsFuture::from(file.text()).await.ok().and_then(|t| t.as_string()).unwrap_or_default();
                match model::google_client_from_json(&text) {
                    Some((id, secret)) => { client_id.set(id); client_secret.set(secret); google_error.set(None); }
                    None => google_error.set(Some("That file has no client ID and secret.".into())),
                }
            });
        });
        input.set_onchange(Some(onchange.unchecked_ref()));
        input.click();
    });
    view! {
        <main class="conn">
            <Masthead title="Connections" compact=true lede="Mail and calendar accounts connected to Moss."/>
            {move || failed.get().then(|| view! {
                <div role="alert"><EmptyState title="Connections could not be loaded"
                    description="Use Reload page above to try again. Nothing was changed."/></div>
            })}
            {move || done.get().then(|| view! { <p role="status">"Connected Google. Calendar and email are ready."</p> })}
            {move || (!show_google.get()).then(|| view! {
                <Button variant=ButtonVariant::Primary on_click=Callback::new(move |_| { done.set(false); show_google.set(true); })>"Connect Google"</Button>
            })}
            {move || show_google.get().then(|| view! {
                <GoogleConnect phase=phase.into() client_id client_secret redirect error=google_error.into()
                    busy=busy.into() on_open on_finish on_cancel on_file/>
            })}
            {move || rows.get().map(|accounts| view! {
                <AccountList accounts busy=busy.into() on_switch on_revoke/>
            })}
        </main>
    }
}
