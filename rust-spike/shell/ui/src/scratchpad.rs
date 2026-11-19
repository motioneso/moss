//! A persistent slot for the installed Scratchpad package. Drafts live in the guest, not here.
use crate::{
    api,
    frame::{Icon, Navigate},
    icons,
};
use leptos::{html, prelude::*, task::spawn_local};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};

#[component]
pub fn Scratchpad(
    open: RwSignal<bool>,
    chat_open: RwSignal<bool>,
    phone: ReadSignal<bool>,
) -> impl IntoView {
    let shortcut = RwSignal::new("mod+shift+s".to_string());
    let panel = NodeRef::<html::Iframe>::new();
    let button = NodeRef::<html::Button>::new();
    let navigate = expect_context::<Navigate>().0;
    let close = move || {
        open.set(false);
        if let Some(button) = button.get_untracked() {
            let _ = button.focus();
        }
    };
    spawn_local(async move {
        if let Some(saved) = api::scratchpad_shortcut().await {
            shortcut.set(saved);
        }
    });
    // Phone sheets are exclusive, including when resizing a desktop with both open.
    Effect::new(move |_| {
        if phone.get() && open.get() {
            chat_open.set(false);
        }
    });
    Effect::new(move |_| {
        let opened = open.get();
        let is_phone = phone.get();
        if let Some(frame) = panel.get() {
            if let Some(window) = frame.content_window() {
                let payload = serde_json::json!({"channel":"moss.scratchpad.visibility","open":opened,"phone":is_phone});
                if let Ok(data) = js_sys::JSON::parse(&payload.to_string()) {
                    let _ = window.post_message(
                        &data,
                        &web_sys::window()
                            .unwrap()
                            .location()
                            .origin()
                            .unwrap_or_default(),
                    );
                }
            }
        }
    });
    let key =
        Closure::<dyn Fn(web_sys::KeyboardEvent)>::new(move |event: web_sys::KeyboardEvent| {
            if event.repeat() || event.is_composing() {
                return;
            }
            let value = shortcut.get_untracked();
            let parts: Vec<_> = value.split('+').map(str::trim).collect();
            let modifiers = &parts[..parts.len().saturating_sub(1)];
            let has_mod = modifiers
                .iter()
                .any(|p| ["mod", "ctrl", "cmd", "meta"].contains(p));
            if parts
                .last()
                .is_some_and(|p| *p == event.key().to_lowercase())
                && has_mod == (event.ctrl_key() || event.meta_key())
                && modifiers.contains(&"shift") == event.shift_key()
                && modifiers.contains(&"alt") == event.alt_key()
            {
                event.prevent_default();
                if open.get_untracked() {
                    close();
                } else {
                    open.set(true);
                }
            }
        });
    let window = web_sys::window().unwrap();
    let _ = window.add_event_listener_with_callback("keydown", key.as_ref().unchecked_ref());
    let message =
        Closure::<dyn Fn(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
            let window = web_sys::window().unwrap();
            if event.origin() != window.location().origin().unwrap_or_default() {
                return;
            }
            let source =
                js_sys::Reflect::get(event.as_ref(), &"source".into()).unwrap_or(JsValue::NULL);
            let from_panel = panel
                .get_untracked()
                .and_then(|f| f.content_window())
                .is_some_and(|w| source == JsValue::from(w));
            let from_settings = window
                .document()
                .and_then(|d| d.get_element_by_id("scratchpad-settings-frame"))
                .and_then(|e| e.dyn_into::<web_sys::HtmlIFrameElement>().ok())
                .and_then(|f| f.content_window())
                .is_some_and(|w| source == JsValue::from(w));
            if !from_panel && !from_settings {
                return;
            }
            let data = event.data();
            let field = |name: &str| {
                js_sys::Reflect::get(&data, &name.into())
                    .ok()
                    .and_then(|v| v.as_string())
                    .unwrap_or_default()
            };
            if field("channel") != "moss.scratchpad.shell" {
                return;
            }
            match field("action").as_str() {
                "close" if from_panel => close(),
                "settings" if from_panel => {
                    close();
                    navigate.run("/scratchpad-settings".into());
                }
                "navigate" => {
                    let path = field("path");
                    if path.starts_with('/')
                        && !path.starts_with("//")
                        && !path.contains('\\')
                        && !path.chars().any(char::is_control)
                    {
                        navigate.run(path);
                    }
                }
                "shortcut" => {
                    let value = field("shortcut");
                    if value.len() <= 100 && value.contains('+') {
                        shortcut.set(value);
                    }
                }
                _ => {}
            }
        });
    let _ = window.add_event_listener_with_callback("message", message.as_ref().unchecked_ref());
    let listeners = StoredValue::new_local((window, key, message));
    on_cleanup(move || {
        listeners.with_value(|(window, key, message)| {
            let _ =
                window.remove_event_listener_with_callback("keydown", key.as_ref().unchecked_ref());
            let _ = window
                .remove_event_listener_with_callback("message", message.as_ref().unchecked_ref());
        })
    });
    view! {
        <button type="button" class=move || if open.get() { "jds-iconbtn jds-iconbtn--active" } else { "jds-iconbtn" }
            title="Scratchpad" aria-label="Scratchpad" aria-pressed=move || open.get().to_string()
            node_ref=button on:click=move |_| { if open.get_untracked() { close(); } else { open.set(true); } }>
            <Icon svg=icons::PENCIL name="pencil" size=18 />
        </button>
        <div class=move || if chat_open.get() && !phone.get() { "scratchpad-slot scratchpad-slot--beside" } else { "scratchpad-slot" }
            hidden=move || !open.get() role=move || phone.get().then_some("dialog")
            aria-modal=move || phone.get().then_some("true") aria-label="Scratchpad">
            <iframe node_ref=panel title="Scratchpad panel" src="/module-frame?module=scratchpad&path=%2Fscratchpad"></iframe>
        </div>
    }
}
