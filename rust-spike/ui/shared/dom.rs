//! Keeps keyboard focus on the same row after the list reloads.

use wasm_bindgen::JsCast;

const CHECKBOXES: &str = ".tk-task__check input";

fn document() -> web_sys::Document {
    web_sys::window().expect("window").document().expect("document")
}

/// Position of the checkbox that has focus, among all checkboxes on the page.
pub fn focused_checkbox_index() -> Option<u32> {
    let active = document().active_element()?;
    let all = document().query_selector_all(CHECKBOXES).ok()?;
    (0..all.length()).find(|i| all.item(*i).is_some_and(|node| node == *active.as_ref()))
}

/// Focus the checkbox now at `index` (or the last one) once the list has re-rendered.
pub async fn refocus_checkbox(index: u32) {
    gloo_timers::future::TimeoutFuture::new(40).await;
    let all = match document().query_selector_all(CHECKBOXES) {
        Ok(all) if all.length() > 0 => all,
        _ => return,
    };
    let target = index.min(all.length() - 1);
    if let Some(input) = all.item(target).and_then(|n| n.dyn_into::<web_sys::HtmlElement>().ok()) {
        let _ = input.focus();
    }
}

/// Mark the moment the first real rows are on screen.
pub fn mark(name: &str) {
    if let Some(performance) = web_sys::window().and_then(|w| w.performance()) {
        let _ = performance.mark(name);
    }
}
