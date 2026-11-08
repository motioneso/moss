//! Notes stays inside Connections; no standalone Notes navigation is introduced.
use leptos::prelude::*;
use moss_module_ui::{Button, ButtonType, ButtonVariant, EmptyState, Field, FormLabel, Masthead};
fn action(id: &'static str, label: &'static str) -> impl IntoView {
    view! { <span data-action=id><Button variant=ButtonVariant::Secondary>{label}</Button></span> }
}
pub fn render() -> String {
    let html = view! {
        <Masthead title="Connections" eyebrow="Settings" lede="Choose the notes folder on your Moss server."/>
        <main class="notes-settings" id="notes-app">
            <p class="jds-caption">"Notes checkpoint: sync and chat tools are not available yet."</p>
            <p id="notice" role="status" aria-live="polite">"Checking linked folder…"</p>
            <section aria-labelledby="notes-heading" class="notes-section">
                <h2 id="notes-heading">"Notes folder"</h2>
                <div id="load-error" hidden role="alert"><EmptyState title="Couldn't check linked folder" description="Check your connection and try again before changing the folder."/>{action("reload","Try again")}</div>
                <div id="folder-state" hidden>
                    <p id="linked-path"></p><p id="sync-status" class="jds-caption"></p>
                    <div class="notes-actions">{action("browse","Browse…")}{action("unlink","Unlink")}</div>
                </div>
                <section id="chooser" hidden aria-labelledby="chooser-heading">
                    <h3 id="chooser-heading" tabindex="-1">"Choose a folder"</h3>
                    <p class="jds-caption">"These folders are on the server, which may be a different computer."</p>
                    <form id="path-form" class="notes-fields">
                        <Field><FormLabel control_id="folder-path">"Folder path"</FormLabel>
                            <input id="folder-path" class="jds-input" autocomplete="off" required/>
                        </Field>
                        <div class="notes-actions"><Button kind=ButtonType::Submit>"Link folder"</Button>{action("list-path","Open path")}{action("roots","Allowed folders")}{action("cancel","Cancel")}</div>
                    </form>
                    <p id="browse-error" role="alert"></p><p id="browse-path" class="jds-caption"></p>
                    <ul id="directories" class="notes-folders"></ul>
                </section>
                <section id="unlink-confirm" hidden role="group" aria-labelledby="unlink-heading">
                    <h3 id="unlink-heading" tabindex="-1">"Unlink this folder?"</h3>
                    <p>"Moss will stop reading your notes. Your files are untouched."</p>
                    <div class="notes-actions">{action("confirm-unlink","Unlink folder")}{action("cancel-unlink","Keep folder")}</div>
                </section>
            </section>
        </main>
    }.to_html();
    format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Connections · Moss</title><link rel=\"stylesheet\" href=\"/module-shared/park-press.css\"><link rel=\"stylesheet\" href=\"./notes.css\"><script type=\"module\" src=\"./app.mjs\"></script></head><body>{html}</body></html>")
}
