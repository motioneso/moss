//! Keyboard focus for the phone navigation and the phone chat drawer, matching the current
//! app's `trapFocus` and dialog lifecycle: Tab cycles inside the open layer, and closing it
//! hands focus back to the button that opened it.

use wasm_bindgen::JsCast;
use web_sys::{Element, HtmlElement, KeyboardEvent};

const FOCUSABLE: &str = "a[href], button:not([disabled]), textarea:not([disabled]), \
    input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

fn focusable(root: &Element) -> Vec<HtmlElement> {
    let Ok(list) = root.query_selector_all(FOCUSABLE) else {
        return Vec::new();
    };
    (0..list.length())
        .filter_map(|i| list.item(i))
        .filter_map(|node| node.dyn_into::<HtmlElement>().ok())
        .filter(|el| el.offset_parent().is_some() || el.get_client_rects().length() > 0)
        .collect()
}

/// Keeps Tab and Shift+Tab inside `root`, wrapping at either end.
pub fn trap_tab(event: &KeyboardEvent, root: &Element) {
    let nodes = focusable(root);
    if nodes.is_empty() {
        event.prevent_default();
        return;
    }
    let active = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.active_element());
    let current = nodes
        .iter()
        .position(|n| active.as_ref() == Some(n.unchecked_ref::<Element>()));
    let last = nodes.len() - 1;
    let next = match (current, event.shift_key()) {
        (Some(i), false) if i == last => 0,
        (None, false) => 0,
        (Some(0) | None, true) => last,
        _ => return,
    };
    event.prevent_default();
    let _ = nodes[next].focus();
}

/// Focuses the first focusable element inside `root`.
pub fn focus_first(root: &Element) {
    if let Some(first) = focusable(root).first() {
        let _ = first.focus();
    }
}
