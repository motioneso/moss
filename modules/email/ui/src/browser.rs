use crate::{model, views::SettingsForm};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Masthead, EmptyState};
use serde_json::Value;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace=emailBridge, js_name=request)]
    fn bridge_request(method: &str, path: &str, body: &str) -> js_sys::Promise;
}

async fn request(method: &str, path: &str, body: Value) -> Result<Value, ()> {
    let result = JsFuture::from(bridge_request(method, path, &body.to_string()))
        .await
        .map_err(|_| ())?;
    serde_json::from_str(&result.as_string().ok_or(())?).map_err(|_| ())
}

async fn load() -> Result<Value, ()> {
    let source = request("GET", "/briefing-source", Value::Null).await?;
    let briefing = request("GET", "/briefing-settings", Value::Null).await?;
    let mode = request("GET", "/task-creation-mode", Value::Null).await?;
    let policy = request("GET", "/draft-policy", Value::Null).await?;
    Ok(model::combine(&source, &briefing, &mode, &policy))
}

#[component]
pub fn EmailSettings() -> impl IntoView {
    let settings = RwSignal::new(None::<Value>);
    let load_failed = RwSignal::new(false);
    let refresh_failed = RwSignal::new(false);
    let save_failed = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let refresh = move || {
        spawn_local(async move {
            match load().await {
                Ok(next) => {
                    load_failed.set(false);
                    refresh_failed.set(false);
                    settings.set(Some(next));
                }
                Err(()) if settings.get_untracked().is_some() => refresh_failed.set(true),
                Err(()) => load_failed.set(true),
            }
        });
    };
    refresh();
    let on_change = Callback::new(move |(key, value): (String, Value)| {
        let Some((method, path, body)) = model::save_request(&key, &value) else { return };
        busy.set(true);
        save_failed.set(false);
        spawn_local(async move {
            if request(method, path, body).await.is_err() {
                save_failed.set(true);
            }
            busy.set(false);
            refresh();
        });
    });
    view! {
        <main class="email-settings">
            <Masthead title="Email" compact=true lede="How your assistant uses your email."/>
            {move || (settings.get().is_none() && !load_failed.get()).then(|| view! {
                <p role="status">"Loading email settings…"</p>
            })}
            {move || load_failed.get().then(|| view! {
                <div role="alert"><EmptyState title="Could not load email settings."
                    description="Use Reload page above to try again. Nothing was changed."/></div>
            })}
            {move || refresh_failed.get().then(|| view! {
                <p class="jds-hint jds-hint--error" role="alert">
                    "Could not refresh email settings. Showing the last saved choices."</p>
            })}
            {move || save_failed.get().then(|| view! {
                <p class="jds-hint jds-hint--error" role="alert">"Could not save email settings. Try again."</p>
            })}
            {move || settings.get().map(|value| view! {
                <SettingsForm settings=value busy=busy.into() on_change/>
            })}
        </main>
    }
}
