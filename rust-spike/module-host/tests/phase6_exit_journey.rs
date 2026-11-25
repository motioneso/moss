//! Phase exit reuses the real signed-registry server with healthy permission growth.
#[path = "phase6_catalog_screens.rs"]
mod catalog;
#[test]
#[ignore = "Only through verify-gate and phase exit runner"]
fn phase6_exit_journey() {
    assert!(std::env::var_os("EXIT_JOURNEY").is_some());
    assert!(std::env::var_os("CATALOG_LAN_HOST").is_some());
    catalog::serve_catalog();
}
