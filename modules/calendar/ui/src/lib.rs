//! Calendar presentation. Account data only enters through the parent's module bridge.
#[cfg(target_arch = "wasm32")]
mod browser;
mod event_details;
pub mod model;
#[cfg(target_arch = "wasm32")]
mod today;
pub mod today_model;
pub mod toolbar;
pub mod views;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    if today::is_today() {
        leptos::mount::mount_to_body(today::Today);
    } else {
        leptos::mount::mount_to_body(browser::Calendar);
    }
}
