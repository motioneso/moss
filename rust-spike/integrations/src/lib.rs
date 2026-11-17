//! Connected-tool sorting for chat. Pure logic with no input or output, so the same code runs
//! natively in the host and as WebAssembly. The database, routes and queue sit in the host.
pub mod js;
pub mod names;
#[cfg(any(test, feature = "selftest"))]
pub mod selftest;
pub mod sort;
pub mod sortmap;
pub mod tool;

pub const CLASSIFIER_ATTEMPT_LIVE_MS: i64 = 30 * 60_000;

/// A sort call that started less than 30 minutes ago may still be running.
pub fn attempt_live(started_at: &str, now_ms: i64) -> bool {
    js::parse_iso_ms(started_at).is_some_and(|s| now_ms - s < CLASSIFIER_ATTEMPT_LIVE_MS)
}

/// WebAssembly entry that runs the fixture replay and returns the number of disagreements.
#[cfg(feature = "selftest")]
#[no_mangle]
pub extern "C" fn selftest_failures() -> u32 {
    selftest::failures().len() as u32
}
