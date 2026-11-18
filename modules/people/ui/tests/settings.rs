use leptos::prelude::*;
use moss_people_ui::PeopleSettings;
#[test]
fn first_render_exposes_accessible_loading_and_disabled_note_writes() {
    let owner = Owner::new();
    let html = owner.with(|| view! {<PeopleSettings/>}.to_html());
    for text in [
        "People notes",
        "Loading your People folder",
        "Loading match candidates",
        "Loading people",
        "Suggest note updates",
        "Add a person manually",
        "Create person",
        "Person email",
    ] {
        assert!(html.contains(text), "Missing {text}: {html}");
    }
    assert!(html.contains("role=\"switch\""));
    assert!(html.contains("for=\"create-name\""));
    assert!(html.contains("disabled"));
    assert!(
        !html.contains("No people yet"),
        "A loading read must not pretend it found no people"
    );
}
