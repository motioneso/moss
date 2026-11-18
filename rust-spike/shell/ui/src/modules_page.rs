//! Modules: what the registry offers and the permission prompt before an install.

use leptos::prelude::*;
use leptos::task::spawn_local;

use crate::api::{self, AvailableModule, ModulePlan};

#[derive(Clone)]
enum Step {
    Idle,
    Reading(String),
    Asking(ModulePlan),
    Installing(String),
    Done(String),
    Failed(String),
}

#[component]
pub fn ModulesPage() -> impl IntoView {
    let list = RwSignal::new(None::<Result<Vec<AvailableModule>, String>>);
    let step = RwSignal::new(Step::Idle);
    let reload = move || {
        spawn_local(async move {
            list.set(Some(api::available_modules().await.map(|l| l.modules)));
        })
    };
    reload();

    let start = move |id: String| {
        step.set(Step::Reading(id.clone()));
        spawn_local(async move {
            step.set(match api::module_plan(&id).await {
                Ok(plan) => Step::Asking(plan),
                Err(e) => Step::Failed(e),
            });
        });
    };
    let approve = move |plan: ModulePlan| {
        step.set(Step::Installing(plan.name.clone()));
        spawn_local(async move {
            match api::install_module(&plan.id, &plan.version).await {
                Ok(()) => {
                    step.set(Step::Done(plan.name));
                    reload();
                }
                Err(e) => step.set(Step::Failed(e)),
            }
        });
    };

    view! {
        <section class="today-hero" aria-label="Modules">
            <h1 class="today-hero__headline">"MOD" <span class="today-hero__headline-accent">"ULES"</span></h1>
            <p class="today-hero__summary">"Add features to this server from its module registry."</p>
        </section>
        <div class="cmd-wrap">
            {move || match step.get() {
                Step::Idle => ().into_any(),
                Step::Reading(id) => view! {
                    <p class="cmd-empty" role="status">{format!("Reading {id}...")}</p>
                }.into_any(),
                Step::Installing(name) => view! {
                    <p class="cmd-empty" role="status">{format!("Installing {name}...")}</p>
                }.into_any(),
                Step::Done(name) => view! {
                    <p class="cmd-empty" role="status">{format!("{name} is installed.")}</p>
                }.into_any(),
                Step::Failed(error) => view! {
                    <p class="cmd-empty" role="alert">{format!("That did not work. {error}")}</p>
                }.into_any(),
                Step::Asking(plan) => {
                    let to_install = plan.clone();
                    view! {
                        <div class="jds-card jds-card--raised" role="dialog" aria-label="Permissions">
                            <h2 class="jds-card-title">{format!("Install {} {}?", plan.name, plan.version)}</h2>
                            <p>{plan.description.clone()}</p>
                            {if plan.permissions.is_empty() {
                                view! { <p>"It asks for no special permissions."</p> }.into_any()
                            } else {
                                view! {
                                    <p>"It asks to:"</p>
                                    <ul>
                                        {plan.permissions.iter().map(|p| view! {
                                            <li>
                                                <strong>{p.headline.clone()}</strong>
                                                {p.details.iter().map(|d| view! { <div>{d.clone()}</div> }).collect_view()}
                                            </li>
                                        }).collect_view()}
                                    </ul>
                                }.into_any()
                            }}
                            <div>
                                <button type="button" class="jds-btn jds-btn--primary"
                                    on:click=move |_| approve(to_install.clone())>"Allow and install"</button>
                                " "
                                <button type="button" class="jds-btn jds-btn--quiet"
                                    on:click=move |_| step.set(Step::Idle)>"Cancel"</button>
                            </div>
                        </div>
                    }.into_any()
                }
            }}
            {move || match list.get() {
                None => view! { <p class="cmd-empty" aria-busy="true">"Loading..."</p> }.into_any(),
                Some(Err(error)) => view! {
                    <p class="cmd-empty" role="status">{format!("The registry could not be read. {error}")}</p>
                }.into_any(),
                Some(Ok(modules)) if modules.is_empty() => view! {
                    <p class="cmd-empty" role="status">"The registry has no modules."</p>
                }.into_any(),
                Some(Ok(modules)) => view! {
                    <ul class="modules-list">
                        {modules.into_iter().map(|m| {
                            let id = m.id.clone();
                            view! {
                                <li class="jds-card">
                                    <h2 class="jds-card-title">{format!("{} {}", m.id, m.version)}</h2>
                                    <p>{m.changelog.clone()}</p>
                                    {if m.installed {
                                        view! { <span class="jds-badge">"Installed"</span> }.into_any()
                                    } else {
                                        view! {
                                            <button type="button" class="jds-btn jds-btn--secondary"
                                                on:click=move |_| start(id.clone())>"Install"</button>
                                        }.into_any()
                                    }}
                                </li>
                            }
                        }).collect_view()}
                    </ul>
                }.into_any(),
            }}
        </div>
    }
}
