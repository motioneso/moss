#[test]
fn connections_screen_uses_shared_controls_and_offers_sync_now() {
    let page = moss_notes_checks::screen::render();
    assert!(page.contains("Connections"));
    for text in [
        "Notes folder",
        "Choose a folder",
        "Folder path",
        "Link folder",
        "Unlink this folder?",
        "Your files are untouched.",
        "Sync now",
    ] {
        assert!(page.contains(text), "Missing {text}");
    }
    assert!(page.contains("jds-btn--secondary"));
    assert!(page.contains("/module-shared/park-press.css"));
    assert!(page.contains("./app.mjs"));
    assert!(!page.contains("fetch("));
}
