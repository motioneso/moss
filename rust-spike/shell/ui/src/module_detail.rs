//! Detail remains display-only except for the existing pin choice and the header settings cog.
use crate::{
    frame::{Icon, Navigate},
    module_catalog,
};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Badge, BadgeTone, Button, ButtonVariant, EmptyState, IconButton};
use moss_shell_contract::catalog_view::ModuleView;

#[component]
pub fn ModuleDetail(module: ModuleView, can_manage: bool, reload: Callback<()>) -> impl IntoView {
    let navigate = expect_context::<Navigate>().0;
    let preview = RwSignal::new(0usize);
    let preview_error = RwSignal::new(false);
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let m = StoredValue::new(module.clone());
    let name = module.name.clone();
    let pin_label = if module.pinned {
        "Unpin".into()
    } else {
        format!(
            "Pin {}",
            module.installed_version.clone().unwrap_or_default()
        )
    };
    let pin = move |_| {
        if pending.get_untracked() {
            return;
        }
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            let module = m.get_value();
            let version = if module.pinned {
                None
            } else {
                module.installed_version
            };
            let result = module_catalog::post::<serde_json::Value>(
                &format!("/api/modules/{}/pin", module.id),
                serde_json::json!({"source":module.source,"version":version}),
            )
            .await;
            pending.set(false);
            match result {
                Ok(_) => reload.run(()),
                Err(message) => error.set(Some(message)),
            }
        });
    };
    let is_installed = module.installed_version.is_some();
    let screenshots = StoredValue::new(module.screenshots.clone());
    view! {
        <header class="catalog-head">
            <div><p class="jds-eyebrow">"Settings / Modules"</p><h1>{name.clone()}</h1></div>
            {module.settings_path.clone().map(|path| view! {
                <IconButton aria_label=format!("{} settings",name) on_click=Callback::new(move |_| navigate.run(path.clone()))>
                    <Icon svg=r#"<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3Z"/><circle cx="12" cy="12" r="3"/>"# name="settings" />
                </IconButton>
            })}
        </header>
        <a class="jds-btn jds-btn--link" href="/settings/modules?view=browse">"Modules"</a>
        <div class="catalog-summary">
            <p>{module.description}</p>
            <p class="jds-caption">{format!("{} · {} · {}",module.publisher,module.source_name,module.installed_version.as_deref().unwrap_or(&module.version))}</p>
            <div class="catalog-actions">
                <Badge>{if is_installed {"Installed"} else {"Available"}}</Badge>
                {module.update_available.then(|| view!{<Badge tone=BadgeTone::Amber>"Update available"</Badge>})}
                {module.pinned.then(||view!{<Badge>"Pinned"</Badge>})}
                {(can_manage && is_installed).then(||view! {
                    <Button variant=ButtonVariant::Quiet disabled=pending on_click=Callback::new(pin)>{pin_label}</Button>
                })}
            </div>
            {move || error.get().map(|message|view!{<p role="alert">{message}</p>})}
        </div>
        {if module.screenshots.is_empty() { view!{<EmptyState title="No screenshots provided."/>}.into_any() } else {
            view! {
                <section class="catalog-previews" aria-label="Screenshots">
                    <figure>
                        <img class="catalog-preview" on:error=move |_|preview_error.set(true) on:load=move |_|preview_error.set(false) src=move || screenshots.with_value(|s|s[preview.get()].url.clone()) alt=move || screenshots.with_value(|s|s[preview.get()].caption.clone())/>
                        <figcaption class="jds-caption" aria-live="polite">{move || screenshots.with_value(|s|format!("{} · Preview {} of {}",s[preview.get()].caption,preview.get()+1,s.len()))}</figcaption>
                    </figure>
                    {move ||preview_error.get().then(||view!{<p role="alert">"Screenshot unavailable."</p>})}
                    <div class="catalog-actions">
                        <Button variant=ButtonVariant::Secondary disabled=Signal::derive(move ||preview.get()==0) on_click=Callback::new(move |_|preview.update(|p| *p-=1))>"Previous screenshot"</Button>
                        <Button variant=ButtonVariant::Secondary disabled=Signal::derive(move ||preview.get()+1>=screenshots.with_value(Vec::len)) on_click=Callback::new(move |_|preview.update(|p| *p+=1))>"Next screenshot"</Button>
                    </div>
                </section>
            }.into_any()
        }}
        <section class="jds-brief"><h2>"What it can touch"</h2>
            {if module.permissions.is_empty() {view!{<p>"No extra permissions."</p>}.into_any()} else {view!{<ul>{module.permissions.into_iter().map(|p|view!{<li>{p}</li>}).collect_view()}</ul>}.into_any()}}
        </section>
        <section class="jds-brief"><h2>"What’s new"</h2><p>{if module.changelog.is_empty(){"No changelog provided.".into()}else{module.changelog}}</p></section>
        <section class="jds-brief"><h2>"Recently"</h2>
            {if module.activity.is_empty(){view!{<p>"No recent activity."</p>}.into_any()}else{module.activity.into_iter().map(|a|view!{<div class="catalog-activity"><strong>{a.label}</strong><p class="jds-caption">{format!("{} · {}",activity_date(&a.at),a.source)}</p></div>}).collect_view().into_any()}}
        </section>
    }
}

#[component]
pub fn ModuleSettingsPage(path: String) -> impl IntoView {
    let target = RwSignal::new(None::<Result<Option<ModuleView>, String>>);
    spawn_local(async move {
        target.set(Some(module_catalog::read().await.map(|view| {
            view.modules
                .into_iter()
                .find(|m| m.settings_path.as_deref() == Some(&path))
        })));
    });
    view! {{move || match target.get() {
        None => view!{<p role="status">"Reading module settings…"</p>}.into_any(),
        Some(Err(error)) => view!{<p role="alert">{error}</p><a class="jds-btn jds-btn--link" href="/settings/modules">"Modules"</a><Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|{let _ = web_sys::window().unwrap().location().reload();})>"Retry"</Button>}.into_any(),
        Some(Ok(None)) => view!{<crate::frame::NotPortedYet/>}.into_any(),
        Some(Ok(Some(module))) => view!{<iframe class="module-screen" title=format!("{} settings", module.name) src=format!("/module-frame?module={}&path={}",js_sys::encode_uri_component(&module.id),js_sys::encode_uri_component(module.settings_path.as_deref().unwrap_or_default()))></iframe>}.into_any(),
    }}}
}

fn activity_date(at: &str) -> String {
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_str(at));
    if date.to_date_string() == js_sys::Date::new_0().to_date_string() {
        "Today".into()
    } else {
        date.to_locale_date_string("default", &js_sys::Object::new())
            .into()
    }
}
