//! Today's "refresh email" control. It starts a sync of the person's connected mail
//! accounts and shows progress until the server reports an end state.

use std::time::Duration;

use leptos::prelude::*;
use leptos::task::spawn_local;

use crate::api::{self, RefreshState};

const POLL: Duration = Duration::from_secs(1);

#[derive(Clone, PartialEq)]
enum Phase {
    Idle,
    Running,
    Done(RefreshState),
    Failed,
}

/// A fresh random id for one click. One id is kept per run, so a repeat joins the run.
fn new_key() -> String {
    let crypto = web_sys::window()
        .and_then(|w| js_sys::Reflect::get(&w, &"crypto".into()).ok())
        .unwrap_or_default();
    js_sys::Reflect::get(&crypto, &"randomUUID".into())
        .ok()
        .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
        .and_then(|f| f.call0(&crypto).ok())
        .and_then(|v| v.as_string())
        .unwrap_or_default()
}

use wasm_bindgen::JsCast;

fn poll(id: String, phase: RwSignal<Phase>) {
    spawn_local(async move {
        match api::email_refresh_state(&id).await {
            Ok(state) if matches!(state.status.as_str(), "queued" | "running") => {
                set_timeout(move || poll(id, phase), POLL);
            }
            Ok(state) => phase.set(Phase::Done(state)),
            Err(_) => phase.set(Phase::Failed),
        }
    });
}

#[component]
pub fn EmailRefresh() -> impl IntoView {
    let available = RwSignal::new(false);
    let phase = RwSignal::new(Phase::Idle);
    spawn_local(async move { available.set(api::has_mail_account().await) });

    let start = move |_| {
        if phase.get_untracked() == Phase::Running {
            return;
        }
        phase.set(Phase::Running);
        spawn_local(async move {
            match api::start_email_refresh(&new_key()).await {
                Ok(id) => poll(id, phase),
                Err(_) => phase.set(Phase::Failed),
            }
        });
    };

    move || {
        available.get().then(|| {
            let busy = phase.get() == Phase::Running;
            view! {
                <section class="today-quiet-line" aria-label="Email refresh">
                    <button
                        type="button"
                        class="jds-btn jds-btn--sm"
                        disabled=busy
                        on:click=start
                    >"Refresh email"</button>
                    {move || match phase.get() {
                        Phase::Idle => ().into_any(),
                        Phase::Running => view! {
                            <p class="cmd-empty" role="status">"Refreshing email…"</p>
                        }.into_any(),
                        Phase::Failed => view! {
                            <p class="cmd-empty" role="status">
                                "Email couldn’t be refreshed. Your current report and plan choices are still available."
                            </p>
                        }.into_any(),
                        Phase::Done(state) if state.status == "succeeded" => view! {
                            <p class="cmd-empty" role="status">"Email is up to date."</p>
                        }.into_any(),
                        Phase::Done(state) => {
                            let missing = state.accounts.iter().filter(|a| a.status != "succeeded").count();
                            view! {
                                <p class="cmd-empty" role="status">
                                    {format!("Some email may still be missing. {missing} of {} accounts did not finish.", state.accounts.len())}
                                </p>
                            }.into_any()
                        }
                    }}
                </section>
            }
        })
    }
}
