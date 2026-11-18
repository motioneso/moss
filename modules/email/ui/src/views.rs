//! Markup for the settings form. Pure rendering, so tests can render it on the server.
use crate::model;
use leptos::prelude::*;
use moss_module_ui::{Field, FormLabel};
use serde_json::{json, Value};

#[component]
fn Switch(
    label: &'static str,
    checked: bool,
    busy: Signal<bool>,
    on_toggle: Callback<bool>,
) -> impl IntoView {
    view! {
        <label class="jds-switch">
            <input type="checkbox" checked=checked prop:checked=checked disabled=move || busy.get()
                on:change=move |event| on_toggle.run(event_target_checked(&event))/>
            <span class="jds-switch__track"><span class="jds-switch__thumb"></span></span>
            <span class="jds-switch__label">{label}</span>
        </label>
    }
}

#[component]
pub fn SettingsForm(
    settings: Value,
    busy: Signal<bool>,
    on_change: Callback<(String, Value)>,
) -> impl IntoView {
    let flag = |key: &str| settings[key].as_bool().unwrap_or(false);
    let mode = settings["mode"].as_str().unwrap_or("suggest").to_string();
    let toggle = move |key: &'static str| {
        Callback::new(move |on: bool| on_change.run((key.to_string(), json!(on))))
    };
    let options = model::MODES
        .iter()
        .map(|(value, label, _)| view! {
            <option value=*value selected=(*value == mode)>{*label}</option>
        })
        .collect_view();
    let hint = model::MODES.iter().map(|(_, _, text)| *text).collect::<Vec<_>>().join(" ");
    view! {
        <section class="email-settings-section" aria-label="Briefings">
            <h2>"Briefings"</h2>
            <Switch label="Include important email in briefings" checked=flag("enabled") busy
                on_toggle=toggle("enabled")/>
        </section>
        <section class="email-settings-section" aria-label="Tasks">
            <h2>"Tasks"</h2>
            <Field><FormLabel control_id="email-task-mode">"Task creation"</FormLabel>
                <p class="jds-hint" id="email-task-mode-help">{hint}</p>
                <span class="jds-selectwrap"><select id="email-task-mode" class="jds-select"
                    aria-describedby="email-task-mode-help" disabled=move || busy.get()
                    on:change=move |event| on_change.run(("mode".into(), json!(event_target_value(&event))))>
                    {options}
                </select></span>
            </Field>
            <Switch label="Suggest tasks in briefings" checked=flag("createTasks") busy
                on_toggle=toggle("createTasks")/>
        </section>
        <section class="email-settings-section" aria-label="Replies">
            <h2>"Replies"</h2>
            <Switch label="Suggest replies" checked=flag("suggestReplies") busy
                on_toggle=toggle("suggestReplies")/>
            <Switch label="Draft replies" checked=flag("draftReplies") busy
                on_toggle=toggle("draftReplies")/>
            <Switch label="Suggest sending replies" checked=flag("autoSend") busy
                on_toggle=toggle("autoSend")/>
            <Switch label="Let your assistant draft email replies without asking"
                checked=(settings["tier"] == "trusted_auto") busy
                on_toggle=Callback::new(move |on: bool| on_change.run(("tier".into(), json!(model::tier_for(on)))))/>
        </section>
    }
}
