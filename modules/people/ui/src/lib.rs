//! People Settings in the shared opaque module frame. All data uses the parent bridge.
mod model;
mod pane;
mod transport;
pub use pane::PeopleSettings;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    leptos::mount::mount_to_body(PeopleSettings);
}
