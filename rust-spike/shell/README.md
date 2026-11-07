# Rust UI shell (Phase 4 part 1)

The app frame, Today and the chat drawer in Leptos, served by one Rust program that also opens
as a desktop window. Report: `docs/superpowers/specs/2026-11-07-rust-phase4a-report.md`.

## Layout

| Crate      | What it holds                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `contract` | JSON shapes the UI reads, the `ShellData` trait the server calls, and `StubShellData` (feature `stub`)         |
| `ui`       | Leptos client-side app compiled to wasm: frame and navigation, Today, chat drawer                              |
| `app`      | `moss-shell`: axum server for the UI and its `/api/*` routes, plus the tao + wry desktop window                |
| `assets`   | `index.html` and the script that copies the current app's CSS, fonts, textures and theme boot script unchanged |

This is its own cargo workspace so it never touches `rust-spike/Cargo.toml`.

## Build

Needs a rustup home with the `wasm32-unknown-unknown` target. Nothing is installed globally.

```bash
export RUSTUP_HOME=/path/to/task-local/rustup
export CARGO_TARGET_DIR=/path/to/scratch/target
rust-spike/shell/build.sh
```

The program lands in `$CARGO_TARGET_DIR/dist/moss-shell` with the web build in `dist/web` beside it.

## Run

Browser, on this machine only:

```bash
moss-shell serve --port <port from devports claim>
```

Browser, from other devices on the LAN or tailnet:

```bash
moss-shell serve --host 0.0.0.0 --port <port from devports claim>
```

Desktop window (Linux needs webkit2gtk-4.1 and gtk3):

```bash
moss-shell desktop
```

`--web <dir>` points either mode at a web build somewhere else.

## Data

Every screen reads `StubShellData`, which is invented sample data. The topbar says "Sample data",
the chat status says "Sample replies only" and the model pill says "Sample model". Phase 2/3
replace it by passing their own `ShellData` to `router()` in `app/src/main.rs`.
