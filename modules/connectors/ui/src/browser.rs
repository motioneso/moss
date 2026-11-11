use crate::{model, views::AccountList};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{EmptyState, Masthead};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace=connectorsBridge, js_name=request)]
    fn bridge_request(method: &str, path: &str, body: &str) -> js_sys::Promise;
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
    view! {
        <main class="conn">
            <Masthead title="Connections" compact=true lede="Mail and calendar accounts connected to Moss."/>
            {move || failed.get().then(|| view! {
                <div role="alert"><EmptyState title="Connections could not be loaded"
                    description="Use Reload page above to try again. Nothing was changed."/></div>
            })}
            {move || rows.get().map(|accounts| view! {
                <AccountList accounts busy=busy.into() on_switch on_revoke/>
            })}
        </main>
    }
}
