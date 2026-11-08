use leptos::prelude::*;
use moss_module_ui::{Button, ButtonVariant, EmptyState, Field, FormLabel, Masthead};
#[test]
fn shared_markup_preserves_button_form_and_empty_state_contracts() {
    let html =
        view! {<Button variant=ButtonVariant::Danger disabled=true>"Delete"</Button>}.to_html();
    assert!(html.contains("jds-btn jds-btn--danger"));
    assert!(html.contains("type=\"button\""));
    assert!(html.contains("disabled"));
    let html =
        view! {<Field><FormLabel control_id="title">"Title"</FormLabel><input id="title"/></Field>}
            .to_html();
    assert!(html.contains("jds-field"));
    assert!(html.contains("for=\"title\""));
    let html = view! {<EmptyState title="All clear" description="Add a person to get started."/>}
        .to_html();
    assert!(html.contains("jds-empty__title"));
    assert!(!html.contains("jds-empty__actions"));
    let html = view! {<Masthead title="People" field=true/>}.to_html();
    assert!(html.contains("jds-masthead--field"));
    assert!(html.contains("<h1"));
}
