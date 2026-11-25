use crate::{module_catalog, module_trust};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{Button, ButtonVariant, Dialog, Field, FormLabel};
use moss_shell_contract::module_trust::{PackageReview, RegistryView};
use serde_json::json;
use wasm_bindgen::JsCast;
#[component]
pub fn PackageImport(registries: Vec<RegistryView>) -> impl IntoView {
    let sources: Vec<_> = registries.into_iter().filter(|r| r.confirmed).collect();
    let source = RwSignal::new(sources.first().map(|r| r.id.clone()).unwrap_or_default());
    let files = RwSignal::new(None::<(String, String)>);
    let review = RwSignal::new(None::<PackageReview>);
    let pending = RwSignal::new(false);
    let error = RwSignal::new(None::<String>);
    let installed = RwSignal::new(None::<String>);
    let upload = move |event: web_sys::Event| {
        files.set(None);
        review.set(None);
        error.set(None);
        installed.set(None);
        let Some(input) = event
            .target()
            .and_then(|e| e.dyn_into::<web_sys::HtmlInputElement>().ok())
        else {
            return;
        };
        let Some(list) = input.files() else {
            return;
        };
        let mut package = None;
        let mut signature = None;
        for i in 0..list.length() {
            if let Some(f) = list.get(i) {
                if f.name().ends_with(".mosspkg") {
                    package = Some(f);
                } else if f.name().ends_with(".sig") {
                    signature = Some(f);
                }
            }
        }
        let (Some(package), Some(signature)) = (package, signature) else {
            error.set(Some("Choose a package and its signature.".into()));
            return;
        };
        if package.size() > 64.0 * 1024.0 * 1024.0 || signature.size() > 4096.0 {
            error.set(Some("Package or signature too large.".into()));
            return;
        }
        pending.set(true);
        spawn_local(async move {
            match (
                module_trust::file_bytes(package).await,
                module_trust::file_bytes(signature).await,
            ) {
                (Ok(p), Ok(s)) => match String::from_utf8(s) {
                    Ok(s) => files.set(Some((module_trust::encoded(&p), s))),
                    Err(_) => error.set(Some("Signature could not be read.".into())),
                },
                _ => error.set(Some("Files could not be read.".into())),
            }
            pending.set(false);
        });
    };
    let submit = Callback::new(move |approve: bool| {
        if pending.get_untracked() {
            return;
        }
        let Some((package, signature)) = files.get_untracked() else {
            return;
        };
        pending.set(true);
        error.set(None);
        let source = source.get_untracked();
        spawn_local(async move {
            match module_catalog::post::<PackageReview>(
                "/api/modules/packages/import",
                json!({"source":source,"package":package,"signature":signature,"approve":approve}),
            )
            .await
            {
                Ok(r) if r.installed => {
                    review.set(None);
                    installed.set(Some(r.id));
                }
                Ok(r) => review.set(Some(r)),
                Err(e) => error.set(Some(e)),
            }
            pending.set(false);
        });
    });
    view! {<section class="jds-brief catalog-install"><h2>"Import a package"</h2>
        <Field><FormLabel control_id="package-source">"Source"</FormLabel><select id="package-source" class="jds-select" disabled=move ||pending.get() on:change=move |e|{source.set(event_target_value(&e));review.set(None);}>
            {sources.into_iter().map(|r|view!{<option value=r.id>{r.name}</option>}).collect_view()}
        </select></Field>
        <Field><FormLabel control_id="package-files">"Package and signature"</FormLabel><input id="package-files" type="file" multiple=true accept=".mosspkg,.sig" disabled=move ||pending.get() on:change=upload/></Field>
        {move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}
        <div><Button variant=ButtonVariant::Secondary disabled=Signal::derive(move ||pending.get()||files.get().is_none()||source.get().is_empty()) on_click=Callback::new(move |_|submit.run(false))>"Review package"</Button></div>
        {move ||installed.get().map(|id|view!{<p role="status">"Package installed."</p><a class="jds-btn jds-btn--secondary" href=module_catalog::detail_url(&id,&source.get())>"View details"</a>})}
        {move ||review.get().map(|r|view!{<Dialog title=format!("Install {}",r.name) on_close=Callback::new(move |()|{if !pending.get_untracked(){review.set(None);}})>
            <div class="jds-dialog__head"><h2 class="jds-dialog__title">{format!("Install {}",r.name)}</h2><p class="jds-dialog__desc">{format!("{} · {}",r.source,r.version)}</p></div>
            <div class="jds-dialog__body catalog-install">{move ||error.get().map(|e|view!{<p role="alert">{e}</p>})}<strong>"Root key fingerprint"</strong><p class="catalog-fingerprint">{r.fingerprint}</p><strong>"Package digest"</strong><p class="catalog-fingerprint">{r.digest}</p><h3>"Allow this module to"</h3>{if r.permissions.is_empty(){view!{<p>"No extra permissions."</p>}.into_any()}else{view!{<ul>{r.permissions.into_iter().map(|p|view!{<li>{p}</li>}).collect_view()}</ul>}.into_any()}}</div>
            <div class="jds-dialog__foot"><Button variant=ButtonVariant::Secondary disabled=pending on_click=Callback::new(move |_|review.set(None))>"Cancel"</Button><Button disabled=pending on_click=Callback::new(move |_|submit.run(true))>"Install package"</Button></div>
        </Dialog>})}
    </section>}
}
