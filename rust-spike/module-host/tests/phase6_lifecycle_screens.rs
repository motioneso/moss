//! Lifecycle screens use the same disposable real HTTPS host as install screens.
#[path = "phase6_catalog_screens.rs"]
mod catalog;
#[test]
#[ignore = "Only through verify-gate and lifecycle screens runner"]
fn phase6_lifecycle_screens() {
    assert!(std::env::var_os("LIFECYCLE_SCREENS").is_some());
    catalog::serve_catalog();
}
