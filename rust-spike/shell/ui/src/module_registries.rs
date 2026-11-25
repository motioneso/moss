//! S9 uses the host's staged-root confirmation; checking never trusts a registry.
use crate::{api, module_catalog, module_trust};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{
    Badge, BadgeTone, Button, ButtonVariant, Dialog, EmptyState, Field, FormLabel, TabLink,
};
use moss_shell_contract::module_trust::{Registries, RegistryView};
use serde_json::{json, Value};
#[component]
pub fn RegistriesPage() -> impl IntoView {
    let registries = RwSignal::new(None::<Result<Registries, String>>);
    let staged = RwSignal::new(None::<RegistryView>);
    let id = RwSignal::new(String::new());
    let address = RwSignal::new(String::new());
    let key = RwSignal::new(String::new());
    let upload = RwSignal::new(None::<Value>);
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let reload = Callback::new(move |()| {
        spawn_local(async move {
            registries.set(Some(api::get_json("/api/modules/registries").await));
        })
    });
    reload.run(());
    let check = Callback::new(move |_| {
        if pending.get_untracked() {
            return;
        }
        pending.set(true);
        error.set(None);
        let address = address.get_untracked();
        let location = if address.starts_with("https://") || address.starts_with("http://") {
            json!({"id":id.get_untracked(),"url":address,"rootKey":key.get_untracked()})
        } else {
            json!({"id":id.get_untracked(),"folder":address,"rootKey":key.get_untracked()})
        };
        spawn_local(async move {
            match module_catalog::post("/api/modules/registries", json!({"registry":location}))
                .await
            {
                Ok(r) => {
                    staged.set(Some(r));
                    reload.run(());
                }
                Err(e) => error.set(Some(e)),
            }
            pending.set(false);
        });
    });
    let remove = Callback::new(move |id: String| {
        if pending.get_untracked() {
            return;
        }
        pending.set(true);
        error.set(None);
        spawn_local(async move {
            let result = gloo_net::http::Request::delete(&format!(
                "/api/modules/registries/{}",
                js_sys::encode_uri_component(&id)
            ))
            .send()
            .await;
            match result {
                Ok(r) if r.ok() => {
                    staged.set(None);
                    reload.run(());
                }
                _ => error.set(Some("Registry could not be removed. Retry.".into())),
            }
            pending.set(false);
        });
    });
    view! {<div class="catalog-page catalog-install"><header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>"Registries"</h1></div><a class="jds-btn jds-btn--quiet" href="/settings/modules">"Modules"</a></header>
        <nav class="catalog-tabs jds-tabs" aria-label="Modules views"><TabLink href="/settings/modules">"Installed"</TabLink><TabLink href="/settings/modules?view=browse">"Browse"</TabLink><TabLink active=true href="/settings/modules/registries">"Registries"</TabLink></nav>
        {move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}
        {move ||match registries.get(){
            None=>view!{<p role="status">"Checking registries…"</p>}.into_any(),
            Some(Err(_))=>view!{<EmptyState title="Registries unavailable."><Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|reload.run(()))>"Retry"</Button></EmptyState>}.into_any(),
            Some(Ok(list))=>view!{
                {list.registries.is_empty().then(||view!{<p>"No extra registries."</p>})}
                {list.registries.into_iter().map(|r|{
                    let to_remove=r.id.clone();let to_confirm=r.clone();
                    view!{<article class="catalog-row" data-registry=r.id><div><strong>{r.name.clone()}</strong><p class="jds-caption">{if r.confirmed {"Root confirmed"}else{"Awaiting fingerprint confirmation"}}</p></div><div class="catalog-actions"><Badge tone=if r.health=="healthy"{BadgeTone::Forest}else{BadgeTone::Amber}>{match r.health.as_str(){"healthy"=>"Healthy","expired"=>"Expired",_=>"Offline"}}</Badge>{(!r.confirmed).then(||view!{<Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|staged.set(Some(to_confirm.clone())))>"Confirm fingerprint"</Button>})}<Button variant=ButtonVariant::Quiet disabled=pending on_click=Callback::new(move |_|remove.run(to_remove.clone()))>"Remove"</Button></div></article>}
                }).collect_view()}
                <section class="jds-brief catalog-install"><h2>"Add a registry"</h2>
                    <div class="catalog-trust-fields"><Field><FormLabel control_id="registry-id">"Registry ID"</FormLabel><input id="registry-id" class="jds-input" disabled=move ||pending.get() prop:value=move ||id.get() on:input=move |e|id.set(event_target_value(&e))/></Field>
                    <Field><FormLabel control_id="registry-address">"Address or folder"</FormLabel><input id="registry-address" class="jds-input" disabled=move ||pending.get() placeholder="Registry address or folder" prop:value=move ||address.get() on:input=move |e|address.set(event_target_value(&e))/></Field>
                    <Field><FormLabel control_id="registry-key">"Root public key"</FormLabel><input id="registry-key" class="jds-input" disabled=move ||pending.get() prop:value=move ||key.get() on:input=move |e|key.set(event_target_value(&e))/></Field></div>
                    <div><Button variant=ButtonVariant::Secondary disabled=Signal::derive(move ||pending.get()||id.get().trim().is_empty()||address.get().trim().is_empty()||key.get().trim().is_empty()) on_click=check>"Check registry"</Button></div>
                </section>
                <section class="jds-brief catalog-install" id="import"><h2>"Import a package"</h2>
                    <Field><FormLabel control_id="registry-file">"Signed registry file"</FormLabel><input id="registry-file" type="file" accept=".json" disabled=move ||pending.get() on:change=move |e|{
                        upload.set(None);error.set(None);let Some(file)=module_trust::selected_file(&e)else{return;};
                        if file.size()>96.0*1024.0*1024.0{error.set(Some("Registry file too large.".into()));return;}
                        pending.set(true);spawn_local(async move{match module_trust::file_bytes(file).await.and_then(|bytes|serde_json::from_slice::<Value>(&bytes).map_err(|_|"Registry file could not be read.".into())){Ok(v)=>upload.set(Some(v)),Err(e)=>error.set(Some(e))}pending.set(false);});
                    }/></Field>
                    <div><Button variant=ButtonVariant::Secondary disabled=Signal::derive(move ||pending.get()||upload.get().is_none()) on_click=Callback::new(move |_|{
                        let Some(body)=upload.get_untracked()else{return;};if pending.get_untracked(){return;}pending.set(true);error.set(None);
                        spawn_local(async move{match module_catalog::post("/api/modules/registries/import",body).await{Ok(r)=>{staged.set(Some(r));reload.run(());},Err(e)=>error.set(Some(e))}pending.set(false);});
                    })>"Review package"</Button></div>
                </section>
                <section class="jds-brief catalog-install"><h2>"Local package"</h2><p>"Private to you · Signed on this server"</p><div><a class="jds-btn jds-btn--secondary" href="/settings/modules/local">"Sign and review"</a></div></section>
            }.into_any()
        }}
        {move ||staged.get().map(|r|{
            let cancel_id=r.id.clone();let confirm=r.clone();
            view!{<Dialog title="Confirm root fingerprint" on_close=Callback::new(move |()|{if !pending.get_untracked(){staged.set(None);}})>
                <div class="jds-dialog__head"><h2 class="jds-dialog__title">{r.name}</h2></div><div class="jds-dialog__body catalog-install"><strong>"Root key fingerprint"</strong><p class="catalog-fingerprint">{r.fingerprint}</p>{move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}</div>
                <div class="jds-dialog__foot"><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|remove.run(cancel_id.clone()))>"Cancel"</Button><Button disabled=pending on_click=Callback::new(move |_|{
                    if pending.get_untracked(){return;}pending.set(true);error.set(None);let r=confirm.clone();
                    spawn_local(async move{match module_catalog::post::<Value>(&format!("/api/modules/registries/{}/confirm",js_sys::encode_uri_component(&r.id)),json!({"fingerprint":r.fingerprint})).await{Ok(_)=>{staged.set(None);reload.run(());},Err(e)=>error.set(Some(e))}pending.set(false);});
                })>"Trust and add"</Button></div>
            </Dialog>}
        })}
    </div>}
}
