//! Approved S1 installed, S2 browse and S3 detail. All state comes from the host catalog.
use crate::{
    frame::Icon,
    module_catalog,
    module_controls::{AccountSwitch, Preferences, ServerControl},
    module_detail::ModuleDetail,
};
use leptos::{prelude::*, task::spawn_local};
use moss_module_ui::{
    Badge, BadgeTone, Button, ButtonVariant, EmptyState, Field, FormLabel, IconButton, TabLink,
};
use moss_shell_contract::catalog_view::{CatalogView, ModuleView};

#[component]
pub fn ModulesPage() -> impl IntoView {
    let catalog = RwSignal::new(None::<Result<CatalogView, String>>);
    let reload = Callback::new(move |()| {
        catalog.set(None);
        spawn_local(async move {
            catalog.set(Some(module_catalog::read().await));
        });
    });
    reload.run(());
    let browse = RwSignal::new(module_catalog::query("view").as_deref() == Some("browse"));
    let selected = module_catalog::query("module");
    let source = module_catalog::query("source");
    let search = RwSignal::new(String::new());
    let publisher = RwSignal::new(String::new());
    let category = RwSignal::new(String::new());
    let registry = RwSignal::new(String::new());
    let preferences = RwSignal::new(false);
    let clear = move |_| {
        search.set(String::new());
        publisher.set(String::new());
        category.set(String::new());
        registry.set(String::new());
    };
    let selected = StoredValue::new(selected);
    let source = StoredValue::new(source);
    view! {
        <div class="catalog-page">
            {move || match catalog.get() {
                None => view!{<p role="status" aria-busy="true">{if selected.get_value().is_some(){"Reading module details…"}else if browse.get(){"Checking registries…"}else{"Reading installed modules…"}}</p>}.into_any(),
                Some(Err(_)) => view!{<EmptyState title="Modules could not be read."><Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|reload.run(()))>"Retry"</Button></EmptyState>}.into_any(),
                Some(Ok(view)) => {
                    if let Some(id)=selected.get_value() {
                        return match view.modules.into_iter().find(|m|m.id==id && source.with_value(|s|s.as_deref()==Some(&m.source))) {
                            Some(module)=>view!{<ModuleDetail module=module can_manage=view.management.is_some() reload=reload/>}.into_any(),
                            None=>view!{<EmptyState title="Module details are unavailable."><a class="jds-btn jds-btn--link" href="/settings/modules?view=browse">"Browse modules"</a><Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|reload.run(()))>"Retry"</Button></EmptyState>}.into_any(),
                        };
                    }
                    let can_manage = view.management.is_some();
                    let modules = StoredValue::new(view.modules.clone());
                    let mut categories:Vec<_>=view.modules.iter().map(|m|m.category.clone()).filter(|c|!c.is_empty()).collect();categories.sort();categories.dedup();
                    let categories=StoredValue::new(categories);
                    let sources=StoredValue::new(view.sources.clone());
                    let management=StoredValue::new(view.management.clone());
                    view! {
                        <header class="catalog-head"><div><p class="jds-eyebrow">"Settings / Modules"</p><h1>{move ||if browse.get(){"Browse"}else{"Modules"}}</h1></div>
                            {(can_manage && !browse.get()).then(||view!{<IconButton aria_label="Module management settings" on_click=Callback::new(move |_|preferences.update(|v|*v=!*v))><Icon svg=r#"<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3Z"/><circle cx="12" cy="12" r="3"/>"# name="settings"/></IconButton>})}
                        </header>
                        <nav class="catalog-tabs jds-tabs" aria-label="Modules views">
                            <TabLink active=Signal::derive(move ||!browse.get()) href="/settings/modules">"Installed"</TabLink>
                            <TabLink active=browse href="/settings/modules?view=browse">"Browse"</TabLink>
                            {can_manage.then(||view!{<TabLink href="/settings/modules/registries">"Registries"</TabLink>})}
                        </nav>
                        {move ||preferences.get().then(||view!{<Preferences on_close=Callback::new(move |_|preferences.set(false))/>})}
                        {view.sources.iter().filter(|s|s.error.is_some()).map(|s|view!{<div class="catalog-notice" role="alert"><span>{format!("{} is offline.",s.name)}</span><Button variant=ButtonVariant::Secondary on_click=Callback::new(move |_|reload.run(()))>"Retry"</Button></div>}).collect_view()}
                        <Show when=move ||browse.get()>
                            <div class="catalog-filters">
                                <Field><FormLabel control_id="catalog-search">"Search"</FormLabel><input id="catalog-search" class="jds-input" type="search" placeholder="Find a module" prop:value=move ||search.get() on:input=move |e|search.set(event_target_value(&e))/></Field>
                                <Field><FormLabel control_id="catalog-publisher">"Publisher"</FormLabel><select id="catalog-publisher" class="jds-select" prop:value=move ||publisher.get() on:change=move |e|publisher.set(event_target_value(&e))><option value="">"All publishers"</option><option value="first">"First-party"</option></select></Field>
                                <Field><FormLabel control_id="catalog-category">"Category"</FormLabel><select id="catalog-category" class="jds-select" prop:value=move ||category.get() on:change=move |e|category.set(event_target_value(&e))><option value="">"All categories"</option>{categories.get_value().into_iter().map(|c|view!{<option value=c.clone()>{c.clone()}</option>}).collect_view()}</select></Field>
                                <Field><FormLabel control_id="catalog-source">"Source"</FormLabel><select id="catalog-source" class="jds-select" prop:value=move ||registry.get() on:change=move |e|registry.set(event_target_value(&e))><option value="">"All registries"</option>{sources.get_value().into_iter().map(|s|view!{<option value=s.id>{s.name}</option>}).collect_view()}</select></Field>
                            </div>
                        </Show>
                        <Show when=move ||!browse.get()><div class="catalog-head"><h2>"On this server"</h2><span class="jds-caption">"On for you"</span></div></Show>
                        {move || {
                            let browsing=browse.get();let query=search.get().trim().to_lowercase();
                            let rows:Vec<_>=modules.get_value().into_iter().filter(|m| {
                                if !browsing {return m.installed_version.is_some();}
                                (query.is_empty() || format!("{} {} {}",m.name,m.description,m.id).to_lowercase().contains(&query))
                                && (publisher.get().is_empty() || m.first_party)
                                && (category.get().is_empty() || m.category==category.get())
                                && (registry.get().is_empty() || m.source==registry.get())
                            }).collect();
                            if rows.is_empty() {
                                if browsing {view!{<EmptyState title="No modules match."><Button variant=ButtonVariant::Link on_click=Callback::new(clear)>"Clear filters"</Button></EmptyState>}.into_any()}
                                else {view!{<EmptyState title="No modules installed."><a class="jds-btn jds-btn--link" href="/settings/modules?view=browse">"Browse modules"</a></EmptyState>}.into_any()}
                            }else{view!{<div aria-label=if browsing{"Available modules"}else{"Installed modules"}>{rows.into_iter().map(|m|view!{<CatalogRow module=m installed= !browsing reload=reload/>}).collect_view()}</div>}.into_any()}
                        }}
                        <Show when=move ||!browse.get()>
                            {management.get_value().map(|controls|view!{
                                <details class="catalog-admin"><summary>"Server controls"</summary>
                                    {controls.into_iter().filter_map(|control| modules.get_value().into_iter().find(|m|m.id==control.id && m.source==control.source).map(|module|view!{<ServerControl module=module control=control reload=reload/>})).collect_view()}
                                    <div class="catalog-row"><div><strong>"Module list"</strong></div><div class="catalog-actions"><a class="jds-btn jds-btn--link" href="/api/modules/list/export" download="moss-modules.json">"Export"</a><a class="jds-btn jds-btn--link" href="/settings/modules/registries#import">"Import"</a></div></div>
                                </details>
                            })}
                        </Show>
                    }.into_any()
                }
            }}
        </div>
    }
}
#[component]
fn CatalogRow(module: ModuleView, installed: bool, reload: Callback<()>) -> impl IntoView {
    let tone = match module.status.as_str() {
        "Blocked" => BadgeTone::Red,
        "Up to date" => BadgeTone::Forest,
        "Registry warning" => BadgeTone::Amber,
        _ => BadgeTone::Neutral,
    };
    let url = module_catalog::detail_url(&module.id, &module.source);
    let meta = if installed {
        format!(
            "{} · {}",
            module.source_name,
            module.installed_version.clone().unwrap_or_default()
        )
    } else {
        format!(
            "{} · {} · {}",
            module.publisher,
            if module.category.is_empty() {
                "Uncategorized"
            } else {
                &module.category
            },
            module.source_name
        )
    };
    let show_status = !module.update_available || module.status != "Up to date";
    let status = module.status.clone();
    let is_installed = module.installed_version.is_some();
    let switch_module = module.clone();
    view! {
        <article class="catalog-row" data-module=module.id.clone() data-source=module.source.clone()>
            <div><strong><a href=url.clone()>{module.name.clone()}</a></strong><p class="jds-caption">{meta}</p></div>
            <div class="catalog-actions">
                {if installed {view!{
                    {show_status.then(||view!{<Badge tone=tone>{status}</Badge>})}
                    {module.update_available.then(||view!{<Badge tone=BadgeTone::Amber>"Update available"</Badge>})}
                    {module.pinned.then(||view!{<Badge>"Pinned"</Badge>})}
                    {(module.status != "Blocked").then(||view!{<AccountSwitch module=switch_module reload=reload/>})}
                }.into_any()}else{view!{<Badge>{if is_installed{"Installed"}else{"Available"}}</Badge>{(!is_installed).then(||view!{<a class="jds-btn jds-btn--secondary" href=url>"View"</a>})}}.into_any()}}
            </div>
        </article>
    }
}
