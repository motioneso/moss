//! The real HTTPS shell, signed registry and builder-local fixtures; no network interception.
#[path = "phase6_catalog_screens.rs"]
mod catalog;
#[test]
#[ignore = "Only through verify-gate and trust screens runner"]
fn phase6_trust_screens() {
    assert!(std::env::var_os("TRUST_SCREENS").is_some());
    catalog::serve_catalog();
}
