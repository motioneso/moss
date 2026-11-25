//! S10 saved registry notices and builder-private provenance; local review binds exact bytes.
use crate::{api, module_catalog};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{
    Badge, BadgeTone, Button, ButtonVariant, Dialog, EmptyState, Field, FormLabel,
};
use moss_shell_contract::module_trust::{LocalReview, ModuleTrust};
use serde_json::{json, Value};
use wasm_bindgen::JsCast;

pub fn selected_file(event: &web_sys::Event) -> Option<web_sys::File> {
    event
        .target()?
        .dyn_into::<web_sys::HtmlInputElement>()
        .ok()?
        .files()?
        .get(0)
}
pub async fn file_bytes(file: web_sys::File) -> Result<Vec<u8>, String> {
    let buffer = wasm_bindgen_futures::JsFuture::from(file.array_buffer())
        .await
        .map_err(|_| "File could not be read")?;
    Ok(js_sys::Uint8Array::new(&buffer).to_vec())
}
pub fn encoded(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
#[component]
pub fn TrustPage() -> impl IntoView {
    let trust = RwSignal::new(None::<Result<ModuleTrust, String>>);
    let reload = Callback::new(move |()| {
        trust.set(None);
        spawn_local(async move {
            let id = module_catalog::query("module").unwrap_or_default();
            trust.set(Some(
                api::get_json(&format!(
                    "/api/modules/trust/{}",
                    js_sys::encode_uri_component(&id)
                ))
                .await,
            ));
        });
    });
    reload.run(());
    view! {<div class="catalog-page catalog-install"><header class="catalog-head"><p class="jds-eyebrow">"Settings / Modules"</p><a class="jds-btn jds-btn--quiet" href="/settings/modules">"Modules"</a></header>
        {move ||match trust.get(){
            None=>view!{<p role="status">"Reading registry notices…"</p>}.into_any(),
            Some(Err(_))=>view!{<EmptyState title="Package details unavailable."><Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|reload.run(()))>"Retry"</Button></EmptyState>}.into_any(),
            Some(Ok(m))=>{
                let blocked=m.notices.iter().any(|n|n.level=="block");
                let source=module_catalog::query("source").unwrap_or_else(||m.source.clone());let detail=module_catalog::detail_url(&m.id,&source);
                view!{<h1>{if m.local {format!("{} · Local package",m.name)}else if blocked {format!("{} is blocked",m.name)}else{format!("{} needs a look",m.name)}}</h1>
                    <p class="jds-caption">{format!("{} · {}",m.source_name,m.version)}</p>
                    {m.local.then(||view!{<section class="jds-brief catalog-install"><h2>"Local package"</h2><p>"Private to you · Signed on this server"</p><p>"Not registry-reviewed"</p><strong>"Install key fingerprint"</strong><p class="catalog-fingerprint">{m.fingerprint.unwrap_or_default()}</p><strong>"Package digest"</strong><p class="catalog-fingerprint">{m.digest}</p></section>})}
                    {if m.notices.is_empty()&&!m.local {view!{<p>"No registry notices."</p>}.into_any()}else{m.notices.into_iter().map(|n|view!{<section class="jds-brief catalog-install" role="status"><h2>{if n.level=="block" {format!("{} stopped for everyone",m.name)}else{format!("{} needs a look",m.name)}}</h2><Badge tone=if n.level=="block"{BadgeTone::Red}else{BadgeTone::Amber}>{if n.level=="block"{"Blocked"}else{"Still running"}}</Badge><p>{n.reason}</p><p class="jds-caption">{n.source}</p></section>}).collect_view().into_any()}}
                    {(!m.local).then(||view!{<section class="jds-brief"><div class="catalog-row"><strong>"Data"</strong><span>"Kept"</span></div><div class="catalog-row"><strong>"Source"</strong><span>{m.source_name.clone()}</span></div><div class="catalog-row"><strong>"Package"</strong><span>{format!("{} {}",m.name,m.version)}</span></div><div class="catalog-row"><strong>"Next step"</strong><span>{if blocked {"Install a trusted replacement"}else{"Review publisher notice"}}</span></div></section>})}
                    <div class="catalog-actions">{m.can_manage.then(||view!{<a class="jds-btn jds-btn--primary" href=format!("{detail}&screen=update")>"Check for update"</a><a class="jds-btn jds-btn--secondary" href=format!("{detail}&screen=remove")>"Remove"</a>})}<a class="jds-btn jds-btn--secondary" href=detail>"View details"</a></div>
                }.into_any()
            }
        }}
    </div>}
}
#[component]
pub fn LocalPackagePage() -> impl IntoView {
    let bytes = RwSignal::new(None::<String>);
    let review = RwSignal::new(None::<LocalReview>);
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let result = RwSignal::new(None::<String>);
    let choose = move |event: web_sys::Event| {
        bytes.set(None);
        review.set(None);
        error.set(None);
        result.set(None);
        let Some(file) = selected_file(&event) else {
            return;
        };
        if file.size() > 64.0 * 1024.0 * 1024.0 {
            error.set(Some("Package too large.".into()));
            return;
        }
        pending.set(true);
        spawn_local(async move {
            match file_bytes(file).await {
                Ok(b) => bytes.set(Some(encoded(&b))),
                Err(e) => error.set(Some(e)),
            }
            pending.set(false);
        });
    };
    view! {<div class="catalog-page catalog-install"><header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>"Local package"</h1></div><a class="jds-btn jds-btn--quiet" href="/settings/modules">"Modules"</a></header>
        <p>"Private to you · Signed on this server"</p>
        <Field><FormLabel control_id="local-package">"Built package"</FormLabel><input id="local-package" type="file" accept=".mosspkg" disabled=move ||pending.get() on:change=choose/></Field>
        <div><Button variant=ButtonVariant::Secondary disabled=Signal::derive(move ||pending.get()||bytes.get().is_none()) on_click=Callback::new(move |_|{
            let Some(package)=bytes.get_untracked()else{return;};pending.set(true);error.set(None);spawn_local(async move{match module_catalog::post("/api/modules/local/review",json!({"package":package})).await {Ok(r)=>review.set(Some(r)),Err(_)=>error.set(Some("Local package refused. Check the account, package and host key storage.".into()))}pending.set(false);});
        })>"Sign and review"</Button></div>
        {move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}
        {move ||result.get().map(|id|view!{<p role="status">"Local package installed."</p><a class="jds-btn jds-btn--secondary" href=format!("/settings/modules?module={}&screen=trust",js_sys::encode_uri_component(&id))>"Local provenance"</a>})}
        {move ||review.get().map(|r|{
            let name=r.name.clone();let signature=r.signature.clone();let id=r.id.clone();
            view!{<Dialog title=format!("Install {}",name) on_close=Callback::new(move |()|{if !pending.get_untracked(){review.set(None);}})>
                <div class="jds-dialog__head"><h2 class="jds-dialog__title">{format!("Install {}",name)}</h2><p class="jds-dialog__desc">{format!("Local package · {}",r.version)}</p></div>
                <div class="jds-dialog__body catalog-install">{move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}<p>"Private to you · Signed on this server"</p><p>"Not registry-reviewed"</p><strong>"Install key fingerprint"</strong><p class="catalog-fingerprint">{r.fingerprint}</p><strong>"Package digest"</strong><p class="catalog-fingerprint">{r.digest}</p><h3>"Allow this module to"</h3>{if r.permissions.is_empty(){view!{<p>"No extra permissions."</p>}.into_any()}else{view!{<ul>{r.permissions.into_iter().map(|p|view!{<li>{p}</li>}).collect_view()}</ul>}.into_any()}}</div>
                <div class="jds-dialog__foot"><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|review.set(None))>"Cancel"</Button><Button disabled=pending on_click=Callback::new(move |_|{
                    let Some(package)=bytes.get_untracked()else{return;};if pending.get_untracked(){return;}pending.set(true);error.set(None);let signature=signature.clone();let id=id.clone();spawn_local(async move{match module_catalog::post::<Value>("/api/modules/local/install",json!({"package":package,"signature":signature,"approve":true})).await{Ok(_)=>{review.set(None);result.set(Some(id));},Err(_)=>error.set(Some("Local install refused. Check the package and signed-in account.".into()))}pending.set(false);});
                })>"Install local package"</Button></div>
            </Dialog>}
        })}
    </div>}
}
