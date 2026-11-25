//! S6 uses the added permissions in the host's digest-bound review.
use crate::{
    module_catalog,
    module_install::{go, poll, remember},
};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Badge, BadgeTone, Button, ButtonVariant, Dialog};
use moss_shell_contract::module_management::{ModuleOperation, ModuleOperationStage as Stage};
use serde_json::json;

#[component]
pub fn ModuleUpdate() -> impl IntoView {
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
            let result = module_catalog::post::<ModuleOperation>(
                "/api/modules/update-review",
                json!({
                    "module":module_catalog::query("module").unwrap_or_default(),
                    "source":module_catalog::query("source").unwrap_or_default()
                }),
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
                Err(_) => error.set(Some("This update is no longer available.".into())),
            }
            pending.set(false);
        });
    });
    if let Some(id) = module_catalog::query("operation") {
        poll(id, operation, error, alive);
    } else {
        review.run(());
    }
    let cancel = Callback::new(move |()| {
        if !pending.get_untracked() {
            go("/settings/modules");
        }
    });
    let execute = Callback::new(move |_| {
        if pending.get_untracked() {
            return;
        }
        let Some(saved) = operation
            .get_untracked()
            .filter(|s| s.stage == Stage::Reviewed)
        else {
            return;
        };
        let Some(package) = saved.review else {
            return;
        };
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            let result = module_catalog::post::<ModuleOperation>(
                &format!("/api/modules/{}/update", package.module),
                json!({"operation":saved.id,"approve":true}),
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
                Err(message) => error.set(Some(message)),
            }
            pending.set(false);
        });
    });
    let skip = Callback::new(move |_| {
        if pending.get_untracked() {
            return;
        }
        let Some(package) = operation.get_untracked().and_then(|s| s.review) else {
            return;
        };
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            let result = module_catalog::post::<serde_json::Value>(
                &format!("/api/modules/{}/skip", package.module),
                json!({"source":package.source,"digest":package.digest}),
            )
            .await;
            if alive.try_get_untracked() != Some(true) {
                return;
            }
            pending.set(false);
            match result {
                Ok(_) => go("/settings/modules"),
                Err(message) => error.set(Some(message)),
            }
        });
    });
    view! {<div class="catalog-page catalog-install">
        <header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>"Update"</h1></div><a class="jds-btn jds-btn--quiet" href="/settings/modules">"Modules"</a></header>
        {move || error.get().map(|message|view!{<div role="alert" class="catalog-install"><p>{message}</p><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|{
            if let Some(saved)=operation.get_untracked(){poll(saved.id,operation,error,alive);}else if let Some(id)=module_catalog::query("operation"){poll(id,operation,error,alive);}else{review.run(());}
        })>"Retry"</Button></div>})}
        {move ||match operation.get() {
            None=>view!{<p role="status">"Comparing versions…"</p>}.into_any(),
            Some(saved)=> {
                let Some(package)=saved.review else {return view!{<p role="alert">"Update unavailable."</p>}.into_any();};
                let source=if package.source_name.is_empty(){package.source.clone()}else{package.source_name.clone()};
                let meta=format!("{} · {} → {}",source,package.previous_version.clone().unwrap_or_default(),package.version);
                if saved.stage==Stage::Reviewed {
                    return view!{<Dialog title=format!("Update {}",package.name) on_close=cancel>
                        <div class="jds-dialog__head"><h2 class="jds-dialog__title">{format!("Update {}",package.name)}</h2><p class="jds-dialog__desc">{meta}</p></div>
                        <div class="jds-dialog__body catalog-install">
                            <div class="catalog-actions">{package.urgent.then(||view!{<Badge tone=BadgeTone::Amber>"Urgent"</Badge>})}{(!package.new_migrations.is_empty()).then(||view!{<Badge>"Data update"</Badge>})}</div>
                            <section class="jds-brief"><h3>"What’s new"</h3><p>{package.changelog}</p></section>
                            <section class="jds-brief"><h3>"New permission"</h3>{if package.permissions.is_empty(){view!{<p>"No new permissions."</p>}.into_any()}else{view!{<ul class="catalog-permissions">{package.permissions.into_iter().map(|p|view!{<li><strong>{p.headline}</strong>{p.details.into_iter().map(|d|view!{<p>{d}</p>}).collect_view()}</li>}).collect_view()}</ul>}.into_any()}}</section>
                            {move ||error.get().map(|message|view!{<p role="alert">{message}</p>})}
                        </div>
                        <div class="jds-dialog__foot catalog-actions"><Button disabled=pending on_click=execute>"Update"</Button><Button variant=ButtonVariant::Secondary disabled=pending on_click=skip>"Skip"</Button></div>
                    </Dialog>}.into_any();
                }
                let failed=saved.stage==Stage::Failed;
                // The typed SQL failure is returned only after complete_change restores the
                // snapshot and resumes runtime. Recovery failures have a different public reason.
                let restored=failed && package.previous.is_some() && saved.result.as_ref().is_some_and(|r|r.message=="The module data could not be set up.");
                let message=saved.result.map(|r|r.message).unwrap_or_else(||"Updating…".into());
                view!{<h2>{if failed{"Update failed"}else if saved.stage==Stage::Succeeded{"Updated"}else{"Updating…"}}</h2><p class="jds-caption">{meta}</p>
                    <div role=if failed{"alert"}else{"status"} class="catalog-install">
                        <p>{message}</p>
                        {restored.then(||view!{<p>{format!("{} {} was restored.",package.name,package.previous_version.unwrap_or_default())}</p>})}
                    </div>
                    <div class="catalog-actions">{failed.then(||view!{<Button disabled=pending on_click=Callback::new(move |_|review.run(()))>"Retry"</Button>})}<a class="jds-btn jds-btn--secondary" href="/settings/modules">"Modules"</a></div>
                }.into_any()
            }
        }}
    </div>}
}
