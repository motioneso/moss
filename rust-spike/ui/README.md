# Phase 0b UI spike: Tasks priority screen in Leptos and Dioxus

Both crates draw the same screen against the real Rust Tasks server and load the same flattened
Moss CSS (tokens, `@moss/ui`, `styles.css`, `kit-tasks.css`, `tasks.css`) and Archivo fonts.
Shared logic (types, grouping, due-date labels, API calls, focus helper, icons) lives in
`shared/` and is included by both crates with `#[path]`, so only the view code differs.

## Layout

| Path                 | What                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `shared/`            | model, api, dom, icons (framework-agnostic)                             |
| `leptos/`, `dioxus/` | one cargo workspace each, view code only                                |
| `bindgen/`           | helper crate running wasm-bindgen 0.2.130 (no global install)           |
| `assets/`            | `build-assets.py` (CSS and fonts), `index.html` (loader and perf marks) |
| `build.sh`           | build one candidate into an output folder                               |

## Build

Task-local wasm toolchain (leaves `~/.rustup` alone):

```
RUSTUP_HOME=/media/ben/Downloads/unity-scratch/js-36/rustup ~/.cargo/bin/rustup toolchain install stable --profile minimal --target wasm32-unknown-unknown
```

Build a candidate:

```
rust-spike/ui/build.sh leptos /path/to/dist-leptos
```

```
rust-spike/ui/build.sh dioxus /path/to/dist-dioxus
```

## Run

The Tasks server serves the build as static files when `TASKS_SPIKE_STATIC_DIR` is set, so the
page and API share one origin. Start the server as usual (see the Tasks spike docs) with:

```
TASKS_SPIKE_STATIC_DIR=/path/to/dist-leptos TASKS_SPIKE_PORT=<port> target/release/tasks
```

Then open `http://127.0.0.1:<port>/`. The spike signs in with the seed user A bearer token
hardcoded in `shared/api.rs`.

## Measurements

Box load was 15 to 25 throughout, so build times are inflated and noisy.

|                                              | Leptos 0.8.23                               | Dioxus 0.7.10                          |
| -------------------------------------------- | ------------------------------------------- | -------------------------------------- |
| View code (app.rs + main.rs)                 | 300 lines                                   | 272 lines                              |
| Shared Rust / HTML / build scripts           | 282 / 29 / 66 lines (same for both)         | same                                   |
| CSS written                                  | 0 (real CSS reused, about 334 KB flattened) | 0                                      |
| Dependencies (wasm target)                   | 228                                         | 136                                    |
| Clean release build                          | 80 s                                        | 44 s                                   |
| Rebuild after one-line view change           | 10.8 s                                      | 10.4 s                                 |
| Wasm raw / gzip                              | 690,907 / 143,280 B                         | 721,273 / 217,812 B                    |
| JS glue raw / gzip                           | 39,323 / 7,245 B                            | 61,505 / 9,758 B                       |
| First render, median of 15 (page / rows, ms) | 40 / 62                                     | 47 / 70                                |
| Enter adds a task                            | 56 ms                                       | 27 ms                                  |
| Space completes a task                       | 28 ms                                       | 40 ms                                  |
| Latest release                               | 0.8.23 (2026-10-31), 0.9.0-rc1 out          | 0.7.10 (2026-07-30), 0.8.0-alpha.3 out |

Render and action timings are within noise of each other.

Keyboard (identical in both): Tab reaches the capture field after the list nav, Enter adds and
clears the field with focus kept in it, Space on a checkbox completes the task and focus moves to
the next row's checkbox. Real database rows confirmed for both (added tasks exist as `todo`,
completed ones have status `done` and a `completed_at`).

## Desktop and server rendering

- Leptos: no first-party desktop shell. Desktop means wrapping the wasm app in a separate
  webview shell (for example Tauri). Server rendering with hydration is built in
  (`ssr` and `hydrate` features, `leptos_axum`), plus an islands mode.
- Dioxus: first-party desktop renderer on a system webview (wry and tao). A probe crate with the
  `desktop` feature built in 2m35s on this box without libxdo (it is only needed by an optional
  feature) and ran for 6 s on the display without crashing. Binary was 6.5 MB, 430 crates.
  Fullstack server rendering with hydration exists (`fullstack`, `ssr` features). The same view
  code can target web and desktop, but this spike's API calls use browser fetch, so a native build
  would need an HTTP client swap in `shared/api.rs`. That was not done.

## Recommendation

Pick Dioxus, with one caveat about download size.

- It is the only one of the two with a shell for the desktop app that shares view code with the
  web build. The plan wants one product on desktop and browser, so this removes a second shell
  to build and maintain.
- It built in about half the time and has fewer dependencies.
- User-visible speed was the same in both, so speed does not decide it.
- The cost is a bigger download on the web: about 75 KB more gzipped wasm (218 KB against 143 KB).
  That is small next to the 334 KB of CSS, but it is real for phones on slow links.
- Leptos is the more mature web framework and its server rendering story is stronger. If phones
  on the browser matter more than the desktop shell, Leptos is the better choice.

## Not tested

- A native desktop build of the real screen (only an empty probe window).
- Server rendering and hydration in either framework (read from crate features only).
- Phone browsers and slow networks.
- Anything under quiet machine load. Timings are noisy.
