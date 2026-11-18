//! The native half of the two-build proof. The WebAssembly half is in the module host tests.

#[test]
fn every_fixture_passes_natively() {
    assert_eq!(usefulness_rules::fixtures::failures(), Vec::<String>::new());
}

#[test]
fn the_exported_runner_reports_zero_failures() {
    assert_eq!(usefulness_rules::run_fixtures(), 0);
}
