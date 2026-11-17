//! Markup for the account list. Pure rendering, so tests can render it on the server.
use crate::model;
use leptos::prelude::*;
use moss_module_ui::{Button, ButtonSize, ButtonVariant, EmptyState};
use serde_json::Value;

#[component]
pub fn AccountRow(
    account: Value,
    grants: Value,
    busy: Signal<bool>,
    on_switch: Callback<(String, String, bool)>,
    on_revoke: Callback<String>,
) -> impl IntoView {
    let id = account["id"].as_str().unwrap_or("").to_string();
    let name = account["providerDisplayName"].as_str().unwrap_or("Account").to_string();
    let word = model::health(&account);
    let (label, tone) = model::health_label(word);
    let revoked = word == "revoked";
    let switches = ["email", "calendar"]
        .into_iter()
        .filter(|feature| model::offers(&account, feature))
        .map(|feature| {
            let checked = model::granted(&grants, feature);
            let title = if feature == "email" { "Email" } else { "Calendar" };
            let (id, feature) = (id.clone(), feature.to_string());
            view! {
                <label class="jds-switch">
                    <input type="checkbox" aria-label=format!("{title} for {name}") prop:checked=checked
                        disabled=move || busy.get() || revoked
                        on:change=move |event| on_switch.run((id.clone(), feature.clone(), event_target_checked(&event)))/>
                    <span class="jds-switch__track"><span class="jds-switch__thumb"></span></span>
                    <span class="jds-switch__label">{title}</span>
                </label>
            }
        })
        .collect_view();
    let revoke_id = id.clone();
    view! {
        <li class="conn-row" data-account=id>
            <div class="conn-row__main">
                <h3 class="conn-row__name">{name.clone()}</h3>
                <span class=format!("jds-badge jds-badge--{tone}")>{label}</span>
            </div>
            <div class="conn-row__switches">{switches}</div>
            <div class="conn-row__actions">
                {(!revoked).then(|| view! {
                    <Button variant=ButtonVariant::Danger size=ButtonSize::Small disabled=busy
                        on_click=Callback::new(move |_| on_revoke.run(revoke_id.clone()))>"Revoke"</Button>
                })}
            </div>
        </li>
    }
}

#[component]
pub fn AccountList(
    accounts: Vec<(Value, Value)>,
    busy: Signal<bool>,
    on_switch: Callback<(String, String, bool)>,
    on_revoke: Callback<String>,
) -> impl IntoView {
    if accounts.is_empty() {
        return view! {
            <EmptyState title="No connections yet"
                description="Mail and calendar accounts you connect will show up here."/>
        }
        .into_any();
    }
    view! {
        <ul class="conn-list">
            {accounts.into_iter().map(|(account, grants)| view! {
                <AccountRow account grants busy on_switch on_revoke/>
            }).collect_view()}
        </ul>
    }
    .into_any()
}
