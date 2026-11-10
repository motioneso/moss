mod api;
mod chat;
mod focus;
mod frame;
mod icons;
mod modules_page;
mod today;

use wasm_bindgen::JsCast;

/// Replaces the boot loading screen in `#root` with the app.
fn main() {
    let root = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.get_element_by_id("root"))
        .and_then(|el| el.dyn_into::<web_sys::HtmlElement>().ok())
        .expect("#root");
    root.set_inner_html("");
    leptos::mount::mount_to(root, frame::App).forget();
}
