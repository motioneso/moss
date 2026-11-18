use leptos::prelude::*;
use moss_email_ui::{model, views::SettingsForm};
use serde_json::{json, Value};

fn render(settings: Value) -> String {
    view! {<SettingsForm settings busy=Signal::derive(|| false) on_change=Callback::new(|_| {})/>}
        .to_html()
}

#[test]
fn shows_every_old_label_and_mode_description() {
    let html = render(json!({"enabled":true,"mode":"suggest","createTasks":true,
        "suggestReplies":true,"draftReplies":true,"autoSend":false,"tier":"ask_each_time"}));
    for text in [
        "Include important email in briefings", "Task creation", "Suggest tasks in briefings",
        "Suggest replies", "Draft replies", "Suggest sending replies",
        "Let your assistant draft email replies without asking",
        "Never create tasks from email.", "Stage suggestions for your review (default).",
        "Auto-add bills and hard deadlines; stage the rest.",
        "Auto-add anything your assistant is confident about.",
    ] {
        assert!(html.contains(text), "missing {text}: {html}");
    }
}

#[test]
fn switch_state_follows_the_settings() {
    let on = render(json!({"enabled":true,"mode":"off","createTasks":true,"suggestReplies":true,
        "draftReplies":true,"autoSend":true,"tier":"trusted_auto"}));
    assert_eq!(on.matches("checked").count(), 6, "{on}");
    let off = render(json!({"enabled":false,"mode":"auto","createTasks":false,"suggestReplies":false,
        "draftReplies":false,"autoSend":false,"tier":"ask_each_time"}));
    assert!(!off.contains("checked"), "{off}");
}

#[test]
fn each_choice_saves_through_its_own_route() {
    assert_eq!(model::save_request("enabled", &json!(false)),
        Some(("PUT", "/briefing-source", json!({"enabled":false}))));
    assert_eq!(model::save_request("mode", &json!("auto")),
        Some(("PUT", "/task-creation-mode", json!({"mode":"auto"}))));
    assert_eq!(model::save_request("autoSend", &json!(true)),
        Some(("PATCH", "/briefing-settings", json!({"autoSend":true}))));
    assert_eq!(model::save_request("tier", &json!(model::tier_for(true))),
        Some(("PUT", "/draft-policy", json!({"tier":"trusted_auto"}))));
    assert_eq!(model::save_request("bogus", &json!(1)), None);
}
