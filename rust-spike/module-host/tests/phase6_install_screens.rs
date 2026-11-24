//! Shared real instance bootstrap, with an install-specific signed fixture registry.
#[path = "phase6_catalog_screens.rs"]
mod catalog;
#[test]
#[ignore = "Only through verify-gate and the install screens runner"]
fn phase6_install_screens() {
    assert!(std::env::var_os("INSTALL_SCREENS").is_some());
    catalog::serve_catalog();
}
