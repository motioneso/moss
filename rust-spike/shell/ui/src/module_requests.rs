//! S11 member request/status and the explicit admin queue (no automatic notice service).
use crate::{api, module_catalog};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Badge, BadgeTone, Button, ButtonVariant, EmptyState};
use moss_shell_contract::{catalog_view::ModuleView, install_requests::InstallRequest};
use serde::Deserialize;
use serde_json::json;
#[derive(Clone, Deserialize)]
struct Requests {
    requests: Vec<InstallRequest>,
}
fn status(value: &str) -> &str {
    match value {
        "pending" => "Waiting for an admin",
        "declined" => "Declined",
        "succeeded" => "Approved and installed",
        "failed" => "Install failed",
        _ => "Installing",
    }
}
#[component]
pub fn RequestsPanel(admin: bool) -> impl IntoView {
    let rows = RwSignal::new(None::<Result<Requests, String>>);
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let reload = Callback::new(move |()| {
        spawn_local(async move {
            rows.set(Some(api::get_json("/api/modules/requests").await));
        })
    });
    reload.run(());
    view! {<section class="jds-brief catalog-install" aria-label="Install requests">
        <div class="catalog-head"><h2>{if admin {"Install requests"}else{"Your requests"}}</h2><Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_|reload.run(()))>"Check status"</Button></div>
        {move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}
        {move ||match rows.get() {
            None=>view!{<p role="status">"Reading requests…"</p>}.into_any(),
            Some(Err(_))=>view!{<p role="alert">"Requests unavailable. Check again."</p>}.into_any(),
            Some(Ok(list)) if list.requests.is_empty()=>view!{<p>"No requests yet."</p>}.into_any(),
            Some(Ok(mut list))=>{
                list.requests.sort_by_key(|r|r.status!="pending");
                let count=list.requests.iter().filter(|r|r.status=="pending").count();
                view!{
                    {admin.then(||view!{<p role="status">{format!("{count} pending requests")}</p>})}
                    {list.requests.into_iter().map(|r|{
                        let id=r.id.clone();let label=status(&r.status).to_owned();
                        let review=format!("{}&screen=install&request={}",module_catalog::detail_url(&r.module,&r.source),r.id);
                        view!{<article class="catalog-row" data-request=r.id><div><strong>{r.module}</strong><p class="jds-caption">{r.source}</p>{r.declined_at.map(|at|view!{<p class="jds-caption">{format!("Declined {at}")}</p>})}</div><div class="catalog-actions"><Badge tone=if r.status=="pending"{BadgeTone::Amber}else{BadgeTone::Neutral}>{label}</Badge>
                        {(admin && (r.status=="pending" || r.status=="failed")).then(||view!{<a class="jds-btn jds-btn--secondary" href=review>"Review"</a>})}
                        {(admin && r.status=="pending").then(||view!{<Button variant=ButtonVariant::Quiet disabled=pending on_click=Callback::new(move |_|{
                            if pending.get_untracked(){return;}pending.set(true);error.set(None);
                            let id=id.clone();spawn_local(async move{match module_catalog::post::<InstallRequest>(&format!("/api/modules/requests/{id}/decline"),json!({})).await{Ok(_)=>reload.run(()),Err(_)=>error.set(Some("Request could not be declined. Check again.".into()))}pending.set(false);});
                        })>"Decline"</Button>})}
                        </div></article>}
                    }).collect_view()}
                }.into_any()
            }
        }}
    </section>}
}
#[component]
pub fn RequestPage() -> impl IntoView {
    let module = RwSignal::new(None::<Result<Option<ModuleView>, String>>);
    let sent = RwSignal::new(None::<InstallRequest>);
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let read = Callback::new(move |()| {
        spawn_local(async move {
            let id = module_catalog::query("module").unwrap_or_default();
            let source = module_catalog::query("source").unwrap_or_default();
            module.set(Some(module_catalog::read().await.map(|v| {
                v.modules
                    .into_iter()
                    .find(|m| m.id == id && m.source == source)
            })));
            match api::get_json::<Requests>("/api/modules/requests").await {
                Ok(list) => sent.set(
                    list.requests
                        .into_iter()
                        .find(|r| r.module == id && r.source == source),
                ),
                Err(_) => error.set(Some("Request status unavailable. Check again.".into())),
            }
        })
    });
    read.run(());
    view! {<div class="catalog-page catalog-install"><header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>{move ||module.get().and_then(Result::ok).flatten().map(|m|format!("Request {}",m.name)).unwrap_or_else(||"Request to install".into())}</h1></div><a class="jds-btn jds-btn--quiet" href="/settings/modules">"Modules"</a></header>
        {move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}
        {move ||match module.get(){
            None=>view!{<p role="status">"Reading module…"</p>}.into_any(),
            Some(Err(_))=>view!{<EmptyState title="Module unavailable."/>}.into_any(),
            Some(Ok(None))=>view!{<EmptyState title="Module unavailable."/>}.into_any(),
            Some(Ok(Some(m)))=>{
                let name=m.name.clone();
                view!{<p class="jds-caption">{format!("{} · {} · {}",m.publisher,m.source_name,m.version)}</p><p>{m.description}</p>
                    {move ||match sent.get(){
                        Some(r)=>view!{<section class="jds-brief"><h2>"Request sent"</h2><p>{name.clone()}</p><Badge tone=BadgeTone::Amber>{status(&r.status).to_owned()}</Badge></section>}.into_any(),
                        None=>{let id=m.id.clone();let source=m.source.clone();view!{<Button disabled=pending on_click=Callback::new(move |_|{
                            if pending.get_untracked(){return;} pending.set(true);error.set(None);let id=id.clone();let source=source.clone();spawn_local(async move{match module_catalog::post("/api/modules/requests",json!({"module":id,"source":source})).await {Ok(r)=>sent.set(Some(r)),Err(_)=>error.set(Some("Request not sent. Try again.".into()))}pending.set(false);});
                        })>"Ask an admin"</Button>}.into_any()}
                    }}
                }.into_any()
            }
        }}
        <div class="catalog-actions"><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|read.run(()))>"Check status"</Button><a class="jds-btn jds-btn--quiet" href="/settings/modules?view=browse">"Cancel"</a></div>
    </div>}
}
