//! S7/S8 keep confirmation separate from persisted host operations.
use crate::{
    api, module_catalog,
    module_install::{go, poll, remember},
};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Button, ButtonVariant, Dialog, Field, FormLabel};
use moss_shell_contract::{
    catalog_view::ModuleView,
    module_management::{ModuleOperation, ModuleOperationStage as Stage, ModuleSnapshot},
};
use serde_json::json;

fn available(snapshot: &ModuleSnapshot) -> bool {
    js_sys::Date::parse(&snapshot.expires) > js_sys::Date::now() && !snapshot.version.is_empty()
}
fn date(value: &str) -> String {
    js_sys::Date::new(&wasm_bindgen::JsValue::from_str(value))
        .to_locale_date_string("default", &js_sys::Object::new())
        .into()
}
#[component]
pub fn ModuleLifecycleScreen(restore: bool) -> impl IntoView {
    let module_id = StoredValue::new(module_catalog::query("module").unwrap_or_default());
    let module = RwSignal::new(None::<ModuleView>);
    let snapshots = RwSignal::new(Vec::<ModuleSnapshot>::new());
    let selected = RwSignal::new(module_catalog::query("snapshot").unwrap_or_default());
    let operation = RwSignal::new(None::<ModuleOperation>);
    let error = RwSignal::new(None::<String>);
    let pending = RwSignal::new(false);
    let loaded = RwSignal::new(false);
    let typed = RwSignal::new(String::new());
    let alive = RwSignal::new(true);
    on_cleanup(move || alive.set(false));
    let load = Callback::new(move |()| {
        error.set(None);
        loaded.set(false);
        spawn_local(async move {
            let result = module_catalog::read().await;
            if alive.try_get_untracked() != Some(true) {
                return;
            }
            match result {
                Ok(view) if view.management.is_some() => {
                    module.set(view.modules.into_iter().find(|m| {
                        m.id == module_id.get_value()
                            && Some(m.source.clone()) == module_catalog::query("source")
                    }));
                    if restore {
                        match api::get_json::<Vec<ModuleSnapshot>>("/api/modules/snapshots").await {
                            Ok(mut rows) => {
                                rows.retain(|s| s.module == module_id.get_value());
                                rows.sort_by(|a, b| b.created.cmp(&a.created));
                                if selected.get_untracked().is_empty() {
                                    selected.set(
                                        rows.iter()
                                            .find(|s| available(s))
                                            .map(|s| s.id.clone())
                                            .unwrap_or_default(),
                                    );
                                }
                                snapshots.set(rows);
                            }
                            Err(_) => error.set(Some("Snapshots could not be read.".into())),
                        }
                    }
                }
                Ok(_) => error.set(Some("Only the instance owner can manage modules.".into())),
                Err(_) => error.set(Some("Module details could not be read.".into())),
            }
            if alive.try_get_untracked() == Some(true) {
                loaded.set(true);
            }
        });
    });
    load.run(());
    if let Some(id) = module_catalog::query("operation") {
        poll(id, operation, error, alive);
    }
    let cancel = Callback::new(move |()| {
        if !pending.get_untracked() {
            go("/settings/modules");
        }
    });
    let submit = Callback::new(move |delete: bool| {
        if pending.get_untracked() {
            return;
        }
        let Some(m) = module.get_untracked() else {
            return;
        };
        if delete && typed.get_untracked() != m.name {
            error.set(Some("Type the module name.".into()));
            return;
        }
        let request = if restore {
            let Some(snapshot) = snapshots
                .get_untracked()
                .into_iter()
                .find(|s| s.id == selected.get_untracked() && available(s))
            else {
                error.set(Some("Snapshot unavailable.".into()));
                return;
            };
            (
                "/api/modules/restore",
                json!({"module":m.id,"snapshot":snapshot.id,"typedName":snapshot.name,"acknowledgeDataLoss":true}),
            )
        } else {
            (
                "/api/modules/remove",
                json!({"module":m.id,"deleteData":delete,"typedName":typed.get_untracked()}),
            )
        };
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            let result = module_catalog::post::<ModuleOperation>(request.0, request.1).await;
            if alive.try_get_untracked() != Some(true) {
                return;
            }
            match result {
                Ok(saved) => {
                    let id = saved.id.clone();
                    remember(&id);
                    operation.set(Some(saved));
                    poll(id, operation, error, alive);
                }
                Err(message) => error.set(Some(message)),
            }
            pending.set(false);
        });
    });
    view! {<div class="catalog-page catalog-install">
        <header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>{if restore{"Restore"}else{"Remove"}}</h1></div><a class="jds-btn jds-btn--quiet" href="/settings/modules">"Modules"</a></header>
        {move ||error.get().map(|message|view!{<div role="alert" class="catalog-install"><p>{message}</p><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|{
            if let Some(saved)=operation.get_untracked(){poll(saved.id,operation,error,alive);}else if let Some(id)=module_catalog::query("operation"){poll(id,operation,error,alive);}else{load.run(());}
        })>"Retry"</Button></div>})}
        {move || {
            if let Some(saved)=operation.get() {
                let failed=saved.stage==Stage::Failed;
                return view!{<h2>{if failed{"Change failed"}else if saved.stage==Stage::Succeeded{if restore{"Snapshot restored"}else{"Module removed"}}else{if restore{"Restoring…"}else{"Removing…"}}}</h2>
                    <p role=if failed{"alert"}else{"status"}>{saved.result.map(|r|r.message).unwrap_or_else(||"Waiting for the host…".into())}</p>
                    <div class="catalog-actions">{failed.then(||view!{<Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|{operation.set(None);let path=format!("{}&screen={}",module_catalog::detail_url(&module_id.get_value(),&module_catalog::query("source").unwrap_or_default()),if restore{"restore"}else{"remove"});go(&path);})>"Retry"</Button>})}<a class="jds-btn jds-btn--secondary" href="/settings/modules">"Modules"</a></div>
                }.into_any();
            }
            if !loaded.get(){return view!{<p role="status">{if restore{"Reading snapshots…"}else{"Checking module…"}}</p>}.into_any();}
            let Some(m)=module.get() else {return view!{<p role="status">"Module unavailable."</p>}.into_any();};
            let name=m.name.clone();
            let meta=format!("{} · {}{}All accounts",m.source_name,m.installed_version.clone().unwrap_or_default(),if m.installed_version.is_some(){" · "}else{""});
            view!{<Dialog title=format!("{} {}",if restore{"Restore"}else{"Remove"},name) on_close=cancel>
                <div class="jds-dialog__head"><h2 class="jds-dialog__title">{format!("{} {}",if restore{"Restore"}else{"Remove"},name)}</h2><p class="jds-dialog__desc">{meta}</p></div>
                <div class="jds-dialog__body catalog-install">
                    {if restore {view!{
                        <Field><FormLabel control_id="restore-snapshot">"Snapshot"</FormLabel><select id="restore-snapshot" class="jds-select" prop:value=move ||selected.get() disabled=pending on:change=move |e|selected.set(event_target_value(&e))>
                            <option value="">"Choose a snapshot"</option>
                            {snapshots.get_untracked().into_iter().map(|s|{let label=format!("{} · {} · {}{}",date(&s.created),if s.reason=="delete-data"{"Before data deletion"}else{"Before update"},s.version,if available(&s){""}else{" · Unavailable"});view!{<option value=s.id.clone() disabled= !available(&s)>{label}</option>}}).collect_view()}
                        </select></Field>
                        {move || snapshots.get().into_iter().find(|s|s.id==selected.get()).map(|s|view!{
                            <div><div class="catalog-row"><strong>"Available until"</strong><span>{date(&s.expires)}</span></div><div class="catalog-row"><strong>"Restores"</strong><span>{format!("{} {} · All accounts",s.name,s.version)}</span></div><div class="catalog-row"><strong>"Replaces"</strong><span>{format!("Current {} data",name)}</span></div></div>
                            {(!available(&s)).then(||view!{<p role="status">"Snapshot unavailable."</p>})}
                        })}
                        {snapshots.get_untracked().is_empty().then(||view!{<p role="status">"No snapshots available."</p>})}
                    }.into_any()}else{view!{
                        <section class="jds-brief catalog-install"><h3>"Keep the data"</h3><div class="catalog-actions"><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|submit.run(false))>{format!("Remove {}",name)}</Button><Button variant=ButtonVariant::Quiet disabled=pending on_click=Callback::new(move |_|cancel.run(()))>"Cancel"</Button></div></section>
                        <section class="jds-brief catalog-install"><h3>"Delete the data too"</h3><p>"All accounts. A snapshot stays for 30 days."</p><Field><FormLabel control_id="delete-name">{format!("Type {}",name)}</FormLabel><input id="delete-name" class="jds-input" autocomplete="off" disabled=pending prop:value=move ||typed.get() on:input=move |e|typed.set(event_target_value(&e))/></Field></section>
                    }.into_any()}}
                    {move ||error.get().map(|message|view!{<p role="alert">{message}</p>})}
                </div>
                <div class="jds-dialog__foot catalog-actions">
                    {if restore {view!{<Button disabled=Signal::derive(move ||pending.get() || !snapshots.get().iter().any(|s|s.id==selected.get() && available(s))) on_click=Callback::new(move |_|submit.run(false))>"Restore snapshot"</Button>}.into_any()}else{let expected=m.name.clone();view!{<Button variant=ButtonVariant::Danger disabled=Signal::derive(move ||pending.get() || typed.get()!=expected) on_click=Callback::new(move |_|submit.run(true))>"Remove and delete data"</Button>}.into_any()}}
                    <Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|cancel.run(()))>"Cancel"</Button>
                </div>
            </Dialog>}.into_any()
        }}
    </div>}
}
