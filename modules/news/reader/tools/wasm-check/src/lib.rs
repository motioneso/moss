//! Runs the same parity checks as the native test, inside a WebAssembly module.
//!
//! `run` returns the number of differing cases. `report_ptr` and `report_len` locate a text
//! report in module memory. tools/wasm-check/run.mjs loads the module in Node and prints it.

#[allow(dead_code)]
#[path = "../../../tests/parity_checks.rs"]
mod parity_checks;

use std::sync::atomic::{AtomicUsize, Ordering};

static REPORT_PTR: AtomicUsize = AtomicUsize::new(0);
static REPORT_LEN: AtomicUsize = AtomicUsize::new(0);

#[no_mangle]
pub extern "C" fn run() -> u32 {
    let report = parity_checks::run_all();
    let mut text = format!("parity: {} cases checked, {} differ\n", report.checked, report.failures.len());
    for failure in &report.failures {
        text.push_str(&format!("DIFF {failure}\n"));
    }
    let differ = report.failures.len() as u32 + u32::from(report.checked < 400);
    let leaked: &'static str = Box::leak(text.into_boxed_str());
    REPORT_PTR.store(leaked.as_ptr() as usize, Ordering::Relaxed);
    REPORT_LEN.store(leaked.len(), Ordering::Relaxed);
    differ
}

#[no_mangle]
pub extern "C" fn report_ptr() -> usize {
    REPORT_PTR.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn report_len() -> usize {
    REPORT_LEN.load(Ordering::Relaxed)
}
