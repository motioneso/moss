//! Connections presentation. Account data only enters through the parent's module bridge.
#[cfg(target_arch = "wasm32")]
mod browser;
pub mod google;
pub mod model;
pub mod views;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    leptos::mount::mount_to_body(browser::Connections);
}
