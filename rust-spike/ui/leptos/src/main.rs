#[path = "../../shared/api.rs"]
mod api;
#[path = "../../shared/dom.rs"]
mod dom;
#[path = "../../shared/icons.rs"]
mod icons;
#[path = "../../shared/model.rs"]
mod model;

mod app;

fn main() {
    leptos::mount::mount_to_body(app::App);
}
