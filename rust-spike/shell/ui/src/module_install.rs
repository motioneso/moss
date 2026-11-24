//! S4/S5. The URL identifies the host journal; polling never invents progress.
use crate::{api, module_catalog};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Button, ButtonVariant, Dialog, EmptyState};
use moss_shell_contract::module_management::{ModuleOperation, ModuleOperationStage as Stage};
use serde_json::json;
use std::time::Duration;

fn go(path: &str) {
    if let Some(w) = web_sys::window() {
        let _ = w.location().set_href(path);
    }
}
fn selection() -> (String, String) {
    (
        module_catalog::query("module").unwrap_or_default(),
        module_catalog::query("source").unwrap_or_default(),
    )
}
fn remember(id: &str) {
    let (module, source) = selection();
    if let Some(w) = web_sys::window() {
        if let Ok(history) = w.history() {
            let _ = history.replace_state_with_url(
                &wasm_bindgen::JsValue::NULL,
                "",
                Some(&format!(
                    "{}&screen=install&operation={id}",
                    module_catalog::detail_url(&module, &source)
                )),
            );
        }
    }
}
async fn read_operation(id: &str) -> Result<ModuleOperation, ()> {
    let response = gloo_net::http::Request::get(&format!("/api/modules/operations/{id}"))
        .send()
        .await
        .map_err(|_| ())?;
    if response.status() == 403 {
        let (m, s) = selection();
        go(&format!(
            "{}&screen=request",
            module_catalog::detail_url(&m, &s)
        ));
    }
    if response.status() == 401 {
        go("/sign-in");
    }
    if !response.ok() {
        return Err(());
    }
    response.json().await.map_err(|_| ())
}

fn poll(
    id: String,
    operation: RwSignal<Option<ModuleOperation>>,
    error: RwSignal<Option<String>>,
    alive: RwSignal<bool>,
) {
    spawn_local(async move {
        if alive.try_get_untracked() != Some(true) {
            return;
        }
        let result = read_operation(&id).await;
        if alive.try_get_untracked() != Some(true) {
            return;
        }
        match result {
            Ok(saved) => {
                let running = !saved.stage.terminal() && saved.stage != Stage::Reviewed;
                operation.set(Some(saved));
                error.set(None);
                if running {
                    set_timeout(
                        move || poll(id, operation, error, alive),
                        Duration::from_millis(500),
                    );
                }
            }
            Err(_) => error.set(Some("Status unavailable. Check again.".into())),
        }
    });
}
#[component]
pub fn ModuleInstall() -> impl IntoView {
    let operation = RwSignal::new(None::<ModuleOperation>);
    let error = RwSignal::new(None::<String>);
    let pending = RwSignal::new(false);
    let alive = RwSignal::new(true);
    on_cleanup(move || alive.set(false));
    let review = Callback::new(move |()| {
        if pending.get_untracked() {
            return;
        }
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            // The display projection determines the route; the mutation independently enforces admin.
            let allowed = module_catalog::read().await.map(|v| v.management.is_some());
            if matches!(allowed, Ok(false)) {
                let (m, s) = selection();
                go(&format!(
                    "{}&screen=request",
                    module_catalog::detail_url(&m, &s)
                ));
                return;
            }
            if alive.try_get_untracked() != Some(true) {
                return;
            }
            if allowed.is_err() {
                error.set(Some("This package could not be checked. Retry.".into()));
                pending.set(false);
                return;
            }
            let (module, source) = selection();
            let result = module_catalog::post::<ModuleOperation>(
                "/api/modules/review",
                json!({"module":module,"source":source}),
            )
            .await;
            if alive.try_get_untracked() != Some(true) {
                return;
            }
            match result {
                Ok(saved) => {
                    remember(&saved.id);
                    operation.set(Some(saved));
                }
                Err(_) => error.set(Some("This package could not be checked. Retry.".into())),
            }
            pending.set(false);
        });
    });
    if let Some(id) = module_catalog::query("operation") {
        poll(id, operation, error, alive);
    } else {
        review.run(());
    }
    let execute = Callback::new(move |_| {
        if pending.get_untracked() {
            return;
        }
        let Some(saved) = operation.get_untracked() else {
            return;
        };
        if saved.stage != Stage::Reviewed {
            return;
        }
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            let result = module_catalog::post::<ModuleOperation>(
                &format!("/api/modules/operations/{}/execute", saved.id),
                json!({"approve":true}),
            )
            .await;
            if alive.try_get_untracked() != Some(true) {
                return;
            }
            match result {
                Ok(next) => {
                    let id = next.id.clone();
                    operation.set(Some(next));
                    poll(id, operation, error, alive);
                }
                Err(_) => error.set(Some("Install could not be started. Check again.".into())),
            }
            pending.set(false);
        });
    });
    let cancel = Callback::new(move |()| {
        let (m, s) = selection();
        go(&module_catalog::detail_url(&m, &s));
    });
    view! {
        <div class="catalog-page catalog-install">
            <header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>"Install"</h1></div><a class="jds-btn jds-btn--quiet" href="/settings/modules">"Modules"</a></header>
            {move ||error.get().map(|message|view!{<div role="alert" class="catalog-install"><p>{message}</p><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|{
                if let Some(saved)=operation.get_untracked() {poll(saved.id,operation,error,alive);} else if let Some(id)=module_catalog::query("operation") {poll(id,operation,error,alive);} else {review.run(());}
            })>"Retry"</Button></div>})}
            {move || match operation.get() {
                None => view!{<p role="status" aria-busy=move ||pending.get()>"Checking this package…"</p>}.into_any(),
                Some(saved) => {
                    let Some(package)=saved.review.clone() else {return view!{<EmptyState title="No install running."/>}.into_any();};
                    let meta=format!("{} · {} · {}",package.publisher,if package.source_name.is_empty(){&package.source}else{&package.source_name},package.version);
                    if saved.stage==Stage::Reviewed {
                        let name=package.name.clone();
                        return view!{<Dialog title=format!("Install {}",name) on_close=cancel>
                            <div class="jds-dialog__head"><h2 class="jds-dialog__title">{format!("Install {}",name)}</h2><p class="jds-dialog__desc">{meta}</p></div>
                            <div class="jds-dialog__body catalog-install">
                                <section class="jds-brief"><h3>{format!("Allow {} to",name)}</h3>
                                {if package.permissions.is_empty(){view!{<p>"No extra permissions."</p>}.into_any()}else{view!{<ul class="catalog-permissions">{package.permissions.into_iter().map(|p|view!{<li><strong>{p.headline}</strong>{p.details.into_iter().map(|d|view!{<p>{d}</p>}).collect_view()}</li>}).collect_view()}</ul>}.into_any()}}
                                </section>
                                {move ||error.get().map(|message|view!{<p role="alert">{message}</p>})}
                            </div>
                            <div class="jds-dialog__foot catalog-actions"><Button disabled=pending on_click=execute>{format!("Install {}",name)}</Button><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|cancel.run(()))>"Cancel"</Button></div>
                        </Dialog>}.into_any();
                    }
                    let failed=saved.stage==Stage::Failed;
                    let changed=saved.result.as_ref().is_some_and(|r| r.message.contains("changed since review"));
                    let message=saved.result.as_ref().map(|r|r.message.clone()).unwrap_or_default();
                    view!{
                        <h2>{if saved.stage==Stage::Succeeded{format!("{} is ready",package.name)}else{format!("Installing {}",package.name)}}</h2><p class="jds-caption">{meta}</p>
                        {if failed {view!{<div role="alert" class="catalog-install"><h3>{if changed{"This package changed. Review it again."}else if message=="The package could not be downloaded."{"Download stopped"}else if message=="The module data could not be set up."{"Data setup stopped"}else{"Install stopped"}}</h3><p>{message}</p><div class="catalog-actions"><Button disabled=pending on_click=Callback::new(move |_|review.run(()))>"Retry"</Button><Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|cancel.run(()))>"Cancel"</Button></div></div>}.into_any()}else{
                            view!{<ol class="catalog-progress" aria-label="Install progress" aria-live="polite">{stages(&saved).into_iter().map(|(label,current)|view!{<li class="catalog-row" aria-current=current.then_some("step")><span>{label}</span></li>}).collect_view()}</ol>}.into_any()
                        }}
                        {(saved.stage==Stage::Succeeded).then(||view!{<OpenInstalled module=package.module name=package.name/>})}
                    }.into_any()
                }
            }}
        </div>
    }
}
fn stages(operation: &ModuleOperation) -> Vec<(&'static str, bool)> {
    let history = if operation.stages.is_empty() {
        vec![operation.stage]
    } else {
        operation.stages.clone()
    };
    history
        .into_iter()
        .filter(|stage| *stage != Stage::Reviewed && *stage != Stage::Failed)
        .map(|stage| {
            let current = stage == operation.stage;
            let label = match (stage, current) {
                (Stage::Queued, true) => "Queued…",
                (Stage::Queued, false) => "Queued",
                (Stage::Checking, true) => "Checking this package…",
                (Stage::Checking, false) => "Package checked",
                (Stage::Downloading, true) => "Downloading…",
                (Stage::Downloading, false) => "Downloaded",
                (Stage::Verifying, true) => "Checking signature…",
                (Stage::Verifying, false) => "Signature checked",
                (Stage::SettingUpData, true) => "Setting up data…",
                (Stage::SettingUpData, false) => "Data set up",
                (Stage::Activating, true) => "Starting module…",
                (Stage::Activating, false) => "Module started",
                (Stage::Installing, _) => "Installing…",
                (Stage::Succeeded, _) => "Ready",
                _ => "Queued…",
            };
            (label, current)
        })
        .collect()
}
/// Part 14 owns the request form; this is the plain S11 destination only.
#[component]
pub fn InstallRequestRoute() -> impl IntoView {
    view! {<div class="catalog-page"><header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>"Request to install"</h1></div><a class="jds-btn jds-btn--quiet" href="/settings/modules?view=browse">"Modules"</a></header></div>}
}

#[component]
fn OpenInstalled(module: String, name: String) -> impl IntoView {
    let path = RwSignal::new(None::<String>);
    spawn_local(async move {
        let _ = path.try_set(
            api::module_navigation()
                .await
                .into_iter()
                .find(|link| link.module == module)
                .map(|link| link.path),
        );
    });
    view! {{move || match path.get() {
        Some(url)=>view!{<a class="jds-btn jds-btn--primary" href=url>{format!("Open {}",name)}</a>}.into_any(),
        None=>view!{<a class="jds-btn jds-btn--primary" href="/settings/modules">"Modules"</a>}.into_any(),
    }}}
}
