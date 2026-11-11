//! Markup for the Google connect flow. Pure rendering, so tests can render it on the server.
use crate::model;
use leptos::prelude::*;
use moss_module_ui::{Button, ButtonSize, ButtonVariant, Field, FormLabel};

/// Which part of the flow is showing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Credentials,
    Redirect,
}

#[component]
pub fn GoogleConnect(
    phase: Signal<Phase>,
    client_id: RwSignal<String>,
    client_secret: RwSignal<String>,
    redirect: RwSignal<String>,
    error: Signal<Option<String>>,
    consent_url: Signal<Option<String>>,
    busy: Signal<bool>,
    on_open: Callback<()>,
    on_finish: Callback<()>,
    on_cancel: Callback<()>,
    on_file: Callback<()>,
) -> impl IntoView {
    let steps = model::GOOGLE_STEPS.iter().map(|s| view! { <li>{*s}</li> }).collect_view();
    let can_open = Signal::derive(move || {
        busy.get() || !model::google_credentials_ok(&client_id.get(), &client_secret.get())
    });
    let can_finish = Signal::derive(move || busy.get() || !model::google_redirect_ok(&redirect.get()));
    view! {
        <section class="conn-google" aria-label="Connect Google">
            <h2 class="conn-google__title">"Connect Google"</h2>
            <ol class="conn-google__steps">{steps}</ol>
            <Field>
                <FormLabel control_id="google-client-id">"Client ID"</FormLabel>
                <input id="google-client-id" class="jds-input" autocomplete="off"
                    prop:value=move || client_id.get()
                    on:input=move |e| client_id.set(event_target_value(&e))/>
            </Field>
            <Field>
                <FormLabel control_id="google-client-secret">"Client secret"</FormLabel>
                <input id="google-client-secret" class="jds-input" type="password" autocomplete="off"
                    prop:value=move || client_secret.get()
                    on:input=move |e| client_secret.set(event_target_value(&e))/>
            </Field>
            <div class="conn-google__actions">
                <Button variant=ButtonVariant::Secondary size=ButtonSize::Small disabled=busy
                    on_click=Callback::new(move |_| on_file.run(()))>"Use client JSON file"</Button>
                <Button variant=ButtonVariant::Primary disabled=can_open
                    on_click=Callback::new(move |_| on_open.run(()))>"Open consent screen"</Button>
            </div>
            {move || (phase.get() == Phase::Redirect).then(|| view! {
                <h3 class="conn-google__sub">"Finish the connection"</h3>
                {move || consent_url.get().map(|address| view! {
                    <Field>
                        <FormLabel control_id="google-consent">"Consent address. If no window opened, copy this into a new browser tab."</FormLabel>
                        <input id="google-consent" class="jds-input" readonly=true value=address/>
                    </Field>
                })}
                <Field>
                    <FormLabel control_id="google-redirect">"Address Google sent you to"</FormLabel>
                    <input id="google-redirect" class="jds-input" autocomplete="off"
                        placeholder="http://localhost:1/?code=..."
                        prop:value=move || redirect.get()
                        on:input=move |e| redirect.set(event_target_value(&e))/>
                </Field>
                <div class="conn-google__actions">
                    <Button variant=ButtonVariant::Quiet disabled=busy
                        on_click=Callback::new(move |_| on_cancel.run(()))>"Cancel"</Button>
                    <Button variant=ButtonVariant::Primary disabled=can_finish
                        on_click=Callback::new(move |_| on_finish.run(()))>"Finish connection"</Button>
                </div>
            })}
            {move || error.get().map(|text| view! { <p class="conn-google__error" role="alert">{text}</p> })}
            <p class="conn-google__hint">"Stored encrypted on this server."</p>
        </section>
    }
}
