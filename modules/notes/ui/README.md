# Notes controls

Notes has no standalone page or navigation entry. The package screen belongs at
Settings → Connections. Rust renders it using the published Leptos kit; `app.mjs`
handles interaction through the shared document-bound bridge. The package builder
includes the generated HTML, layout CSS, script and guest bridge.

The screen supports browse, typed link, change, confirmed unlink and saved sync
status. Sync and chat tools are explicitly unavailable. The HTTPS check host is
a disposable fixture; joining the assembled Phase 4 settings shell remains open.
See the module README and phase report for reproduction and remaining parity.
