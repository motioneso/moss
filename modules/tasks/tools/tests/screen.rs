#[test]
fn package_screen_uses_the_shared_kit_and_external_bridge_assets() {
    let html = moss_tasks_checks::screen::render();
    assert!(html.contains("jds-masthead--field"));
    assert!(html.contains("jds-btn jds-btn--secondary"));
    assert!(html.contains("for=\"title\""));
    assert!(html.contains("id=\"task-form\""));
    assert!(html.contains("./app.mjs"));
    assert!(!html.contains("onClick="));
    assert!(!html.contains("<script>"));
}
