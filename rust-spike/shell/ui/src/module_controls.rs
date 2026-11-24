//! Account choices and distinct admin configuration controls.
use crate::module_catalog;
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Badge, Button, ButtonVariant, Switch};
use moss_shell_contract::catalog_view::{ModuleControl, ModuleView};

#[component]
pub fn AccountSwitch(module: ModuleView, reload: Callback<()>) -> impl IntoView {
    let enabled = RwSignal::new(module.enabled.unwrap_or(false));
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let id = StoredValue::new(module.id);
    let disabled = !module.supports_user_disable
        || module.status == "Blocked"
        || module.status == "Off for everyone";
    view! {
        <div class="catalog-choice">
            <Switch aria_label=format!("{} on for you",module.name) checked=enabled disabled=Signal::derive(move ||disabled || pending.get())
                on_change=Callback::new(move |next| {
                    if pending.get_untracked() {return;}
                    let previous = enabled.get_untracked(); enabled.set(next); pending.set(true); error.set(None);
                    spawn_local(async move {
                        match module_catalog::switch(&id.get_value(),false,next).await {
                            Ok(()) => reload.run(()),
                            Err(message) => {enabled.set(previous); error.set(Some(message));}
                        }
                        pending.set(false);
                    });
                })/>
            {move || error.get().map(|message|view!{<p role="alert">{message}</p>})}
        </div>
    }
}
#[component]
pub fn ServerControl(
    module: ModuleView,
    control: ModuleControl,
    reload: Callback<()>,
) -> impl IntoView {
    let enabled = RwSignal::new(control.on_for_everyone);
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let id = StoredValue::new(module.id);
    view! {
        <div class="catalog-row">
            <div><strong>{module.name.clone()}</strong><p class="jds-caption">{format!("{} · All accounts",module.source_name)}</p></div>
            <div class="catalog-actions">
                <Badge>{move ||if enabled.get(){"On for everyone"}else{"Off for everyone"}}</Badge>
                <Switch aria_label=format!("{} on for everyone",module.name) checked=enabled disabled=pending on_change=Callback::new(move |next| {
                    if pending.get_untracked(){return;}
                    let previous=enabled.get_untracked(); enabled.set(next); pending.set(true); error.set(None);
                    spawn_local(async move {
                        match module_catalog::switch(&id.get_value(),true,next).await {
                            Ok(())=>reload.run(()),Err(message)=>{enabled.set(previous);error.set(Some(message));}
                        }
                        pending.set(false);
                    });
                })/>
            </div>
            {move ||error.get().map(|message|view!{<p role="alert">{message}</p>})}
        </div>
    }
}
#[component]
pub fn Preferences(on_close: Callback<()>) -> impl IntoView {
    let policy = RwSignal::new(None::<serde_json::Value>);
    let error = RwSignal::new(None::<String>);
    let pending = RwSignal::new(false);
    spawn_local(async move {
        match crate::api::get_json("/api/modules/policy").await {
            Ok(value) => policy.set(Some(value)),
            Err(message) => error.set(Some(message)),
        }
    });
    let save = move |key: &'static str, value: bool| {
        let Some(mut next) = policy.get_untracked() else {
            return;
        };
        next[key] = value.into();
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            match module_catalog::post("/api/modules/policy", next).await {
                Ok(value) => policy.set(Some(value)),
                Err(message) => error.set(Some(message)),
            }
            pending.set(false);
        });
    };
    view! {
        <section class="jds-brief" aria-label="Module management settings">
            <div class="catalog-head"><h2>"Module management"</h2><Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_|on_close.run(()))>"Close"</Button></div>
            {move ||policy.get().map(|_|view! {
                <div class="catalog-row"><span>"Automatic updates"</span><Switch aria_label="Automatic updates" checked=Signal::derive(move ||policy.get().is_some_and(|p|p["automatic"]==true)) disabled=pending on_change=Callback::new(move |v|save("automatic",v))/></div>
                <div class="catalog-row"><span>"Quiet time"</span><Switch aria_label="Quiet time" checked=Signal::derive(move ||policy.get().is_some_and(|p|p["quietTime"]==true)) disabled=pending on_change=Callback::new(move |v|save("quietTime",v))/></div>
            })}
            {move || (policy.get().is_none() && error.get().is_none()).then(||view!{<p role="status">"Reading preferences…"</p>})}
            {move ||error.get().map(|message|view!{<p role="alert">{message}</p>})}
        </section>
    }
}
